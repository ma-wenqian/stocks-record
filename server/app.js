/**
 * 港股买卖记录 —— 跑在 hk 上的服务端
 *
 * 认证不在这里做。前面的 Caddy 用 forward_auth 先问一次 Authelia，
 * 通过了才注入 Remote-User / Remote-Name 头。本进程只信任这两个头。
 *
 * ⚠️ 正因为无条件信任那两个头，**必须只绑 127.0.0.1**：
 *    一旦对公网监听，任何人自带一个 Remote-User 头就是管理员。
 *    ufw 也不要放行 PORT。这和 frps 面板是同一套信任模型。
 */
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeSymbol, findOversell, COST_MODES, normalizeCostMode } from '../public/accounting.js';
import { commonName, findStock } from '../public/stocks.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');

const PORT = Number(process.env.PORT || 9310);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || join(ROOT, 'data', 'stocks.sqlite3');
// 「退出」链接，通常是 IdP 的登出地址。不设就不显示这个按钮。
const LOGOUT_URL = process.env.LOGOUT_URL || '';

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// 建表放在启动时跑，全是 IF NOT EXISTS，重启无害。
// 这样部署就不需要「先手工初始化数据库」那一步 —— 而 systemd 的 DynamicUser
// 会把库放进 /var/lib/private/，手工建的话属主还容易搞错。
db.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
migrate();

/**
 * 结构变更。`CREATE TABLE IF NOT EXISTS` 改不了已存在的表，所以这里显式处理。
 * 每步都先探测再动手，重启无害。
 */
function migrate() {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

  // 2026-09-03: quotes 从「全局共享」改成「按用户」
  if (!cols('quotes').includes('user_id')) {
    console.log('migrate: quotes 改为按用户隔离');
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE quotes RENAME TO quotes_old');
      db.exec(`CREATE TABLE quotes (
        user_id    INTEGER NOT NULL REFERENCES users(id),
        symbol     TEXT NOT NULL,
        price      REAL NOT NULL CHECK (price >= 0),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, symbol)
      )`);
      // 原来是共享的，所以复制给每个用户各一份 —— 不猜谁是主人，也不丢数据
      db.exec(`INSERT INTO quotes (user_id, symbol, price, updated_at)
               SELECT u.id, q.symbol, q.price, q.updated_at FROM quotes_old q CROSS JOIN users u`);
      db.exec('DROP TABLE quotes_old');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // 2026-09-05: 成本口径存到用户上，手机和电脑看到的成本价才是同一个。
  // ⚠️ 纯加列 —— SQLite 的 ADD COLUMN 不重建表、不搬数据，
  //    trades 和 quotes 一个字都不会动。默认 'avg' 就是原来的算法，
  //    所以升级后所有人看到的数字和升级前完全一致。
  if (!cols('users').includes('cost_mode')) {
    console.log("migrate: users 增加 cost_mode 列，默认 'avg'（即原有口径）");
    db.exec("ALTER TABLE users ADD COLUMN cost_mode TEXT NOT NULL DEFAULT 'avg'");
  }

  // 旧索引没带 created_by，被 idx_trades_owner_* 取代了
  for (const idx of ['idx_trades_symbol_date', 'idx_trades_date']) {
    db.exec(`DROP INDEX IF EXISTS ${idx}`);
  }
}

/* ---------------------------------------------------------------- 路由 */

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(res, url.pathname);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      send(res, err.status, { error: err.message });
    } else {
      console.error('unhandled', err);
      send(res, 500, { error: '服务器开小差了，请稍后再试' });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`stocks-record listening on http://${HOST}:${PORT}  db=${DB_PATH}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}

async function handleApi(req, res, url) {
  const path = url.pathname.slice('/api'.length);
  const user = requireUser(req);

  if (path === '/me' && req.method === 'GET') return send(res, 200, { user });
  if (path === '/state' && req.method === 'GET') return send(res, 200, getState(user));
  if (path === '/settings' && req.method === 'PUT') return send(res, 200, updateSettings(await readJson(req), user));
  if (path === '/trades' && req.method === 'POST') return send(res, 201, createTrade(await readJson(req), user));

  const trade = path.match(/^\/trades\/(\d+)$/);
  if (trade) {
    const id = Number(trade[1]);
    if (req.method === 'PUT') return send(res, 200, updateTrade(await readJson(req), id, user));
    if (req.method === 'DELETE') return send(res, 200, deleteTrade(id, user));
  }

  const quote = path.match(/^\/quotes\/([^/]+)$/);
  if (quote && req.method === 'PUT') {
    return send(res, 200, upsertQuote(await readJson(req), decodeURIComponent(quote[1]), user));
  }

  send(res, 404, { error: '接口不存在' });
}

/* ------------------------------------------------------------ 身份 */

/**
 * 身份完全来自 Caddy 注入的头。收不到就说明请求没经过 Caddy ——
 * 那要么是配置错了，要么有人直接摸到了本进程，两种都不能放行。
 */
function requireUser(req) {
  const username = String(req.headers['remote-user'] || '').trim().toLowerCase();
  if (!username) throw new HttpError(401, '未通过认证 —— 这个请求没有经过 Authelia');

  const displayName = String(req.headers['remote-name'] || '').trim() || username;
  return { id: userId(username, displayName), username, name: displayName };
}

const userIdCache = new Map();

/** Authelia 认过的人第一次访问时登记一条，只为了在流水里标出是谁记的 */
function userId(username, displayName) {
  const cached = userIdCache.get(username);
  if (cached && cached.name === displayName) return cached.id;

  db.prepare(
    `INSERT INTO users (username, display_name) VALUES (?, ?)
     ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name`
  ).run(username, displayName);

  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  userIdCache.set(username, { id: row.id, name: displayName });
  return row.id;
}

/* ---------------------------------------------------------------- 业务 */

function getState(user) {
  const trades = db
    .prepare(
      `SELECT id, symbol, name, side, trade_date, price, qty, fee, note, created_at, updated_at
         FROM trades
        WHERE created_by = ?
        ORDER BY trade_date DESC, id DESC`
    )
    .all(user.id);

  const quoteRows = db
    .prepare('SELECT symbol, price, updated_at FROM quotes WHERE user_id = ?')
    .all(user.id);
  const quotes = {};
  for (const q of quoteRows) quotes[q.symbol] = q.price;

  // 读的时候放宽：库里存着旧的或没见过的值就退回默认，不要让整页打不开
  const me = db.prepare('SELECT cost_mode FROM users WHERE id = ?').get(user.id);

  return { trades, quotes, quoteMeta: quoteRows, costMode: normalizeCostMode(me?.cost_mode) };
}

/**
 * 目前只有成本口径一项。
 * 写的时候从严：认不出就报错，让前端退回原来的选择并提示 ——
 * 静默存成默认值的话，界面显示的和库里存的会对不上，下次打开又变回去。
 */
function updateSettings(body, user) {
  const raw = String(body.costMode ?? '');
  if (!Object.hasOwn(COST_MODES, raw)) {
    throw new HttpError(400, `不认识的成本口径「${raw}」`);
  }

  db.prepare('UPDATE users SET cost_mode = ? WHERE id = ?').run(raw, user.id);
  return { ok: true, costMode: raw };
}

function createTrade(body, user) {
  const input = readTrade(body);
  input.name = resolveName(input, user);
  assertNoOversell(input.symbol, { ...input, id: Number.MAX_SAFE_INTEGER }, user);

  const row = db
    .prepare(
      `INSERT INTO trades (symbol, name, side, trade_date, price, qty, fee, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    )
    .get(input.symbol, input.name, input.side, input.trade_date, input.price, input.qty, input.fee, input.note, user.id);

  return { id: row.id };
}

function updateTrade(body, id, user) {
  // ⚠️ 归属条件要和查询写在一起。分成「先查再判断」很容易在某条分支上漏掉，
  //    而漏掉的后果是能改别人的记录。
  const existing = db.prepare('SELECT id FROM trades WHERE id = ? AND created_by = ?').get(id, user.id);
  if (!existing) throw new HttpError(404, '这条记录已经不在了');

  const input = readTrade(body);
  input.name = resolveName(input, user);
  assertNoOversell(input.symbol, { ...input, id }, user, id);

  db.prepare(
    `UPDATE trades
        SET symbol = ?, name = ?, side = ?, trade_date = ?, price = ?, qty = ?, fee = ?,
            note = ?, updated_at = datetime('now')
      WHERE id = ? AND created_by = ?`
  ).run(input.symbol, input.name, input.side, input.trade_date, input.price, input.qty, input.fee, input.note, id, user.id);

  return { ok: true };
}

function deleteTrade(id, user) {
  const row = db.prepare('SELECT symbol FROM trades WHERE id = ? AND created_by = ?').get(id, user.id);
  if (!row) throw new HttpError(404, '这条记录已经不在了');

  // 删掉一笔买入，可能让后面的卖出变成「卖超」，先验一下
  const bad = findOversell(symbolTrades(row.symbol, user, id));
  if (bad) throw new HttpError(400, oversellMessage(bad));

  db.prepare('DELETE FROM trades WHERE id = ? AND created_by = ?').run(id, user.id);
  return { ok: true };
}

function upsertQuote(body, rawSymbol, user) {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) throw new HttpError(400, '股票代码不能为空');

  const price = Number(body.price);
  if (!Number.isFinite(price) || price < 0) throw new HttpError(400, '现价要是一个 ≥ 0 的数字');

  db.prepare(
    `INSERT INTO quotes (user_id, symbol, price, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, symbol) DO UPDATE
       SET price = excluded.price, updated_at = excluded.updated_at`
  ).run(user.id, symbol, price);

  return { ok: true, symbol, price };
}

/**
 * 名称留空时沿用这只股票已有的名称，再退回常用表；
 * 反过来，新填的名称会补齐同代码下之前留空的记录。
 */
function resolveName(input, user) {
  if (!input.name) {
    const prev = db
      .prepare("SELECT name FROM trades WHERE created_by = ? AND symbol = ? AND name != '' ORDER BY id DESC LIMIT 1")
      .get(user.id, input.symbol);
    return prev?.name || commonName(input.symbol);
  }

  db.prepare("UPDATE trades SET name = ? WHERE created_by = ? AND symbol = ? AND name = ''")
    .run(input.name, user.id, input.symbol);
  return input.name;
}

function symbolTrades(symbol, user, excludeId = null) {
  return excludeId
    ? db
        .prepare(
          'SELECT id, symbol, side, trade_date, price, qty, fee FROM trades WHERE created_by = ? AND symbol = ? AND id != ?'
        )
        .all(user.id, symbol, excludeId)
    : db
        .prepare('SELECT id, symbol, side, trade_date, price, qty, fee FROM trades WHERE created_by = ? AND symbol = ?')
        .all(user.id, symbol);
}

function assertNoOversell(symbol, candidate, user, excludeId = null) {
  const bad = findOversell([...symbolTrades(symbol, user, excludeId), candidate]);
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

function readTrade(b) {
  // 先按常用表认一次，「小米」这种名称也能直接收下
  const symbol = findStock(b.symbol)?.symbol || normalizeSymbol(b.symbol);
  if (!symbol) throw new HttpError(400, '请填写股票代码');
  // 港股代码只可能是数字。放行非数字会凭空造出一只不存在的股票，
  // 而且它的成本和盈亏会独立算一份，很难发现。
  if (!/^\d{5}$/.test(symbol)) {
    throw new HttpError(400, `「${String(b.symbol ?? '').trim()}」不是有效的港股代码，请填数字代码（如 00700）`);
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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new HttpError(413, '请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, '请求格式不对'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------ 静态文件 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(res, pathname) {
  // normalize + 前缀校验，挡住 ../ 穿越
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) file = join(PUBLIC_DIR, 'index.html');

  let body;
  try {
    body = await readFile(file);
  } catch {
    // 单页应用：认不出的路径一律回首页
    file = join(PUBLIC_DIR, 'index.html');
    body = await readFile(file);
  }

  const type = MIME[extname(file)] || 'application/octet-stream';

  // 「退出」按钮指向哪由部署方决定（Authelia / Authentik / 无）。
  // 不注入的话占位符原样留着，前端会把按钮藏起来。
  if (type.startsWith('text/html')) {
    body = Buffer.from(body.toString('utf8').replaceAll('__LOGOUT_URL__', LOGOUT_URL));
  }

  // 前端就几个小文件，且改完要立刻生效 —— 不缓存，省得排障时怀疑人生
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}

/* ---------------------------------------------------------------- 杂项 */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(json);
}
