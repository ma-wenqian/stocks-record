/**
 * 港股买卖记录 · Cloudflare Worker
 *
 * 静态页面由 assets 直接托管，这里只负责 /api/*。
 */
import { normalizeSymbol, findOversell } from '../public/accounting.js';
import { commonName, findStock } from '../public/stocks.js';

const SESSION_COOKIE = 'sr_session';
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 天

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(new Request(new URL('/', url), request));
    }

    try {
      return await handleApi(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error('unhandled', err);
      return json({ error: '服务器开小差了，请稍后再试' }, 500);
    }
  },
};

async function handleApi(request, env, url) {
  const path = url.pathname.slice('/api'.length);
  const method = request.method;

  if (path === '/login' && method === 'POST') return login(request, env);
  if (path === '/logout' && method === 'POST') return logout();

  // 以下都需要登录
  const user = await requireUser(request, env);

  if (path === '/me' && method === 'GET') return json({ user });
  if (path === '/state' && method === 'GET') return getState(env);
  if (path === '/trades' && method === 'POST') return createTrade(request, env, user);

  const tradeMatch = path.match(/^\/trades\/(\d+)$/);
  if (tradeMatch) {
    const id = Number(tradeMatch[1]);
    if (method === 'PUT') return updateTrade(request, env, user, id);
    if (method === 'DELETE') return deleteTrade(env, id);
  }

  const quoteMatch = path.match(/^\/quotes\/([^/]+)$/);
  if (quoteMatch && method === 'PUT') {
    return upsertQuote(request, env, user, decodeURIComponent(quoteMatch[1]));
  }

  return json({ error: '接口不存在' }, 404);
}

/* ---------------------------------------------------------------- 业务 */

async function getState(env) {
  const [trades, quotes] = await Promise.all([
    env.DB.prepare(
      `SELECT t.id, t.symbol, t.name, t.side, t.trade_date, t.price, t.qty, t.fee,
              t.note, t.created_at, t.updated_at, u.display_name AS created_by_name
         FROM trades t LEFT JOIN users u ON u.id = t.created_by
        ORDER BY t.trade_date DESC, t.id DESC`
    ).all(),
    env.DB.prepare('SELECT symbol, price, updated_at FROM quotes').all(),
  ]);

  const quoteMap = {};
  for (const q of quotes.results) quoteMap[q.symbol] = q.price;

  return json({
    trades: trades.results,
    quotes: quoteMap,
    quoteMeta: quotes.results,
  });
}

async function createTrade(request, env, user) {
  const input = await readTrade(request);
  input.name = await resolveName(env, input);
  await assertNoOversell(env, input.symbol, { ...input, id: Number.MAX_SAFE_INTEGER });

  const row = await env.DB.prepare(
    `INSERT INTO trades (symbol, name, side, trade_date, price, qty, fee, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`
  )
    .bind(input.symbol, input.name, input.side, input.trade_date, input.price, input.qty, input.fee, input.note, user.id)
    .first();

  return json({ id: row.id }, 201);
}

async function updateTrade(request, env, user, id) {
  const existing = await env.DB.prepare('SELECT id FROM trades WHERE id = ?').bind(id).first();
  if (!existing) throw new HttpError(404, '这条记录已经不在了');

  const input = await readTrade(request);
  input.name = await resolveName(env, input);
  await assertNoOversell(env, input.symbol, { ...input, id }, id);

  await env.DB.prepare(
    `UPDATE trades
        SET symbol = ?, name = ?, side = ?, trade_date = ?, price = ?, qty = ?, fee = ?,
            note = ?, updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(input.symbol, input.name, input.side, input.trade_date, input.price, input.qty, input.fee, input.note, id)
    .run();

  return json({ ok: true });
}

async function deleteTrade(env, id) {
  const row = await env.DB.prepare('SELECT symbol FROM trades WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, '这条记录已经不在了');

  // 删掉一笔买入，可能让后面的卖出变成「卖超」，先验一下
  const rest = await symbolTrades(env, row.symbol, id);
  const bad = findOversell(rest);
  if (bad) throw new HttpError(400, oversellMessage(bad));

  await env.DB.prepare('DELETE FROM trades WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

async function upsertQuote(request, env, user, rawSymbol) {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) throw new HttpError(400, '股票代码不能为空');

  const body = await readJson(request);
  const price = Number(body.price);
  if (!Number.isFinite(price) || price < 0) throw new HttpError(400, '现价要是一个 ≥ 0 的数字');

  await env.DB.prepare(
    `INSERT INTO quotes (symbol, price, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(symbol) DO UPDATE
       SET price = excluded.price, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  )
    .bind(symbol, price, user.id)
    .run();

  return json({ ok: true, symbol, price });
}

/**
 * 名称留空时沿用这只股票已有的名称；反过来，新填的名称会补齐同代码下
 * 之前留空的记录，省得每笔都手打一次。
 */
async function resolveName(env, input) {
  if (!input.name) {
    const prev = await env.DB.prepare(
      "SELECT name FROM trades WHERE symbol = ? AND name != '' ORDER BY id DESC LIMIT 1"
    )
      .bind(input.symbol)
      .first();
    // 记录里没有就查常用表，两边都没有才留空
    return prev?.name || commonName(input.symbol);
  }

  await env.DB.prepare("UPDATE trades SET name = ? WHERE symbol = ? AND name = ''")
    .bind(input.name, input.symbol)
    .run();
  return input.name;
}

/** 取某只股票除 excludeId 外的全部交易，用于校验时间线 */
async function symbolTrades(env, symbol, excludeId = null) {
  const stmt = excludeId
    ? env.DB.prepare(
        'SELECT id, symbol, side, trade_date, price, qty, fee FROM trades WHERE symbol = ? AND id != ?'
      ).bind(symbol, excludeId)
    : env.DB.prepare(
        'SELECT id, symbol, side, trade_date, price, qty, fee FROM trades WHERE symbol = ?'
      ).bind(symbol);
  const { results } = await stmt.all();
  return results;
}

async function assertNoOversell(env, symbol, candidate, excludeId = null) {
  const others = await symbolTrades(env, symbol, excludeId);
  const bad = findOversell([...others, candidate]);
  if (bad) throw new HttpError(400, oversellMessage(bad));
}

function oversellMessage(bad) {
  const t = bad.trade;
  return `${bad.symbol} 在 ${t.trade_date} 卖出 ${fmtQty(t.qty)} 股，但那时只持有 ${fmtQty(bad.held)} 股。请先补上对应的买入记录。`;
}

function fmtQty(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/* ---------------------------------------------------------------- 入参 */

async function readTrade(request) {
  const b = await readJson(request);

  // 先按常用表认一次，「小米」这种名称也能直接收下（前端已经解析过，
  // 这里是兜底：接口不该因为绕过前端就把名称当代码存进去）
  const symbol = findStock(b.symbol)?.symbol || normalizeSymbol(b.symbol);
  if (!symbol) throw new HttpError(400, '请填写股票代码');
  // 港股代码只可能是数字。放行非数字会凭空造出一只不存在的股票，
  // 而且它的成本和盈亏会独立算一份，很难发现。
  if (!/^\d{5}$/.test(symbol)) {
    throw new HttpError(400, `「${String(b.symbol).trim()}」不是有效的港股代码，请填数字代码（如 00700）`);
  }

  const side = String(b.side || '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw new HttpError(400, '方向只能是买入或卖出');

  const trade_date = String(b.trade_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trade_date)) throw new HttpError(400, '交易日期格式应为 YYYY-MM-DD');

  const price = Number(b.price);
  if (!Number.isFinite(price) || price < 0) throw new HttpError(400, '单价要是一个 ≥ 0 的数字');

  const qty = Number(b.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new HttpError(400, '数量要大于 0');

  const fee = b.fee === '' || b.fee === undefined || b.fee === null ? 0 : Number(b.fee);
  if (!Number.isFinite(fee) || fee < 0) throw new HttpError(400, '费用要是一个 ≥ 0 的数字');

  return {
    symbol,
    name: String(b.name || '').trim().slice(0, 60),
    side,
    trade_date,
    price,
    qty,
    fee,
    note: String(b.note || '').trim().slice(0, 200),
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, '请求格式不对');
  }
}

/* ---------------------------------------------------------------- 登录 */

async function login(request, env) {
  const b = await readJson(request);
  const username = String(b.username || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!username || !password) throw new HttpError(400, '请输入用户名和口令');

  const user = await env.DB.prepare(
    'SELECT id, username, display_name, password_hash FROM users WHERE username = ?'
  )
    .bind(username)
    .first();

  // 用户不存在时也跑一遍校验，避免用响应时间猜出哪些用户名存在
  const dummy = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const ok = await verifyPassword(password, user?.password_hash ?? dummy);
  if (!user || !ok) throw new HttpError(401, '用户名或口令不对');

  const token = await signSession({ id: user.id, username: user.username, name: user.display_name }, env);
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';

  return json(
    { user: { id: user.id, username: user.username, name: user.display_name } },
    200,
    {
      'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${SESSION_TTL}`,
    }
  );
}

function logout() {
  return json({ ok: true }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  });
}

async function requireUser(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp('(?:^|;\\s*)' + SESSION_COOKIE + '=([^;]+)'));
  if (!match) throw new HttpError(401, '请先登录');

  const payload = await verifySession(match[1], env);
  if (!payload) throw new HttpError(401, '登录已过期，请重新登录');

  return { id: payload.id, username: payload.username, name: payload.name };
}

async function signSession(payload, env) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + SESSION_TTL };
  const data = b64urlEncode(new TextEncoder().encode(JSON.stringify(body)));
  const sig = await hmac(data, sessionSecret(env));
  return `${data}.${sig}`;
}

async function verifySession(token, env) {
  const [data, sig] = String(token).split('.');
  if (!data || !sig) return null;

  const expected = await hmac(data, sessionSecret(env));
  if (!timingSafeEqual(sig, expected)) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(data)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function sessionSecret(env) {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new HttpError(500, '服务端还没设置 SESSION_SECRET');
  return secret;
}

/* ------------------------------------------------------------ 加密工具 */

async function hmac(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return b64urlEncode(new Uint8Array(sig));
}

/** 口令格式：pbkdf2$<迭代次数>$<saltB64url>$<hashB64url>，由 scripts/add-user.mjs 生成 */
async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1) return false;

  const salt = b64urlDecode(parts[2]);
  const expected = b64urlDecode(parts[3]);

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    expected.length * 8
  );

  return timingSafeEqual(b64urlEncode(new Uint8Array(bits)), parts[3]);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64urlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* ---------------------------------------------------------------- 杂项 */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}
