#!/usr/bin/env node
/**
 * 构建 docs/index.html —— 一个自包含的演示页，挂 GitHub Pages。
 *
 *   node scripts/build-demo.mjs
 *
 * 做三件事：
 *   1. 把 style.css 和三个 JS 模块内联进一个 HTML（去掉 import/export，拼成同一个作用域）
 *   2. 插一层 fetch 拦截当假后端，数据存 localStorage
 *   3. 塞一批演示数据
 *
 * 假后端**复用同一份 accounting.js / stocks.js**，所以卖超校验、代码归一化、
 * 名称匹配这些行为和真实部署完全一致 —— 演示页不是另写一份糊弄人的东西。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const P = (p) => ROOT + p;

const html = readFileSync(P('public/index.html'), 'utf8');
const css = readFileSync(P('public/style.css'), 'utf8');

/**
 * 去掉 ESM 的 import/export，让几个模块能拼进同一个作用域。
 *
 * ⚠️ import 会跨行写（列多了就换行），所以这里必须用 [\s\S] 而不是 . ——
 *    只认单行的话，换行的那条会原样留下来，和内联进来的同名函数撞车，
 *    表现是**演示页整片白屏**而构建一声不吭。剥完由 assertStripped 兜底。
 */
function flatten(file) {
  return readFileSync(P('public/' + file), 'utf8')
    .replace(/^import\s[\s\S]*?from\s*['"][^'"]*['"];?[ \t]*$/gm, '')
    .replace(/^export\s+(?=(const|function|class|let|var)\b)/gm, '')
    .trim();
}

const parts = {
  accounting: flatten('accounting.js'),
  stocks: flatten('stocks.js'),
  app: flatten('app.js'),
};

// 拼在同一个作用域里，重名会静默覆盖 —— 宁可构建时炸掉
assertStripped(parts);
assertNoCollisions(parts);

const body = html
  .replace(/^[\s\S]*?<body>/, '')
  .replace(/<\/body>[\s\S]*$/, '')
  .replace(/<script[^>]*src="\/app\.js"[^>]*><\/script>/, '')
  .trim();

const out = `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="港股记录">
<title>港股买卖记录 · 在线演示</title>
<meta name="description" content="港股买卖流水与盈亏看板。持仓成本 / 摊薄成本两种口径可切，演示数据存在你自己的浏览器里。">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">
<style>
${css}

/* 演示页专属：顶部提示条 */
.demo-bar {
  padding: 10px 16px;
  font-size: 13px;
  text-align: center;
  background: color-mix(in srgb, var(--accent) 14%, var(--surface));
  border-bottom: 1px solid var(--border);
}
.demo-bar b { color: var(--accent); }
.demo-bar button {
  font: inherit;
  font-size: 12px;
  margin-left: 8px;
  padding: 3px 9px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}
</style>
</head>
<body>

<div class="demo-bar">
  这是<b>在线演示</b>，数据全是编的，只存在你自己的浏览器里，随便改。
  <button id="demo-reset">重置演示数据</button>
</div>

${body}

<script type="module">
/* ── 记账核心（和真实部署同一份 public/accounting.js）────────────── */
${parts.accounting}

/* ── 常用港股速查表（同 public/stocks.js）───────────────────────── */
${parts.stocks}

/* ── 假后端：拦 fetch，数据存 localStorage ──────────────────────── */
${demoBackend()}

/* ── 前端（同 public/app.js）───────────────────────────────────── */
${parts.app}
</script>
</body>
</html>
`;

mkdirSync(P('docs'), { recursive: true });
writeFileSync(P('docs/index.html'), out);
console.log(`  docs/index.html  ${(out.length / 1024).toFixed(1)} KB`);

/* ------------------------------------------------------------------ */

function demoBackend() {
  return `
const DEMO_KEY = 'stocks-record-demo-v1';
const DEMO_USER = { id: 1, username: 'demo', name: '演示账号' };

const SEED = ${JSON.stringify(seedData(), null, 2).replace(/\n/g, '\n')};

function loadDemo() {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return structuredClone(SEED);
}

function saveDemo(d) {
  try { localStorage.setItem(DEMO_KEY, JSON.stringify(d)); } catch {}
}

let demo = loadDemo();

document.querySelector('#demo-reset').addEventListener('click', () => {
  demo = structuredClone(SEED);
  saveDemo(demo);
  location.reload();
});

/** 和服务端 readTrade 同样的校验 —— 演示页也不该收下脏数据 */
function demoReadTrade(b) {
  const symbol = findStock(b.symbol)?.symbol || normalizeSymbol(b.symbol);
  if (!symbol) throw { status: 400, error: '请填写股票代码' };
  if (!/^\\d{5}$/.test(symbol))
    throw { status: 400, error: \`「\${String(b.symbol ?? '').trim()}」不是有效的港股代码，请填数字代码（如 00700）\` };

  const side = String(b.side || '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw { status: 400, error: '方向只能是买入或卖出' };

  const trade_date = String(b.trade_date || '').trim();
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(trade_date)) throw { status: 400, error: '交易日期格式应为 YYYY-MM-DD' };

  const price = Number(b.price);
  if (!Number.isFinite(price) || price < 0) throw { status: 400, error: '单价要是一个 ≥ 0 的数字' };

  const qty = Number(b.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw { status: 400, error: '数量要大于 0' };

  const fee = b.fee === '' || b.fee == null ? 0 : Number(b.fee);
  if (!Number.isFinite(fee) || fee < 0) throw { status: 400, error: '费用要是一个 ≥ 0 的数字' };

  return {
    symbol,
    name: String(b.name || '').trim().slice(0, 60),
    side, trade_date, price, qty, fee,
    note: String(b.note || '').trim().slice(0, 200),
  };
}

function demoResolveName(input) {
  if (!input.name) {
    const prev = [...demo.trades].reverse().find((t) => t.symbol === input.symbol && t.name);
    return prev?.name || commonName(input.symbol);
  }
  for (const t of demo.trades) if (t.symbol === input.symbol && !t.name) t.name = input.name;
  return input.name;
}

function demoOversell(symbol, candidate, excludeId) {
  const others = demo.trades.filter((t) => t.symbol === symbol && t.id !== excludeId);
  const bad = findOversell([...others, candidate]);
  if (bad) {
    const q = Number(bad.trade.qty).toLocaleString('en-US', { maximumFractionDigits: 4 });
    const h = Number(bad.held).toLocaleString('en-US', { maximumFractionDigits: 4 });
    throw { status: 400, error: \`\${bad.symbol} 在 \${bad.trade.trade_date} 卖出 \${q} 股，但那时只持有 \${h} 股。请先补上对应的买入记录。\` };
  }
}

const realFetch = window.fetch.bind(window);

window.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.includes('/api/')) return realFetch(input, init);

  const path = url.slice(url.indexOf('/api/') + 4);
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : {};
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  try {
    if (path === '/me') return json({ user: DEMO_USER });

    if (path === '/state') {
      const trades = [...demo.trades].sort((a, b) =>
        a.trade_date === b.trade_date ? b.id - a.id : (a.trade_date < b.trade_date ? 1 : -1));
      return json({
        trades,
        quotes: demo.quotes,
        quoteMeta: Object.entries(demo.quotes).map(([symbol, price]) => ({
          symbol, price, updated_at: demo.quoteAt[symbol] || '',
        })),
        costMode: normalizeCostMode(demo.costMode),
      });
    }

    // 和服务端一样：写的时候从严，认不出就报错
    if (path === '/settings' && method === 'PUT') {
      const raw = String(body.costMode ?? '');
      if (!Object.hasOwn(COST_MODES, raw)) return json({ error: \`不认识的成本口径「\${raw}」\` }, 400);
      demo.costMode = raw;
      saveDemo(demo);
      return json({ ok: true, costMode: raw });
    }

    if (path === '/trades' && method === 'POST') {
      const input = demoReadTrade(body);
      input.name = demoResolveName(input);
      const id = Math.max(0, ...demo.trades.map((t) => t.id)) + 1;
      demoOversell(input.symbol, { ...input, id: Number.MAX_SAFE_INTEGER });
      demo.trades.push({ ...input, id, created_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
      saveDemo(demo);
      return json({ id }, 201);
    }

    const m = path.match(/^\\/trades\\/(\\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const i = demo.trades.findIndex((t) => t.id === id);
      if (i < 0) return json({ error: '这条记录已经不在了' }, 404);

      if (method === 'PUT') {
        const input = demoReadTrade(body);
        input.name = demoResolveName(input);
        demoOversell(input.symbol, { ...input, id }, id);
        demo.trades[i] = { ...demo.trades[i], ...input };
        saveDemo(demo);
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        const symbol = demo.trades[i].symbol;
        const rest = demo.trades.filter((t) => t.id !== id);
        const bad = findOversell(rest.filter((t) => t.symbol === symbol));
        if (bad) {
          const q = Number(bad.trade.qty).toLocaleString('en-US', { maximumFractionDigits: 4 });
          const h = Number(bad.held).toLocaleString('en-US', { maximumFractionDigits: 4 });
          return json({ error: \`\${bad.symbol} 在 \${bad.trade.trade_date} 卖出 \${q} 股，但那时只持有 \${h} 股。请先补上对应的买入记录。\` }, 400);
        }
        demo.trades = rest;
        saveDemo(demo);
        return json({ ok: true });
      }
    }

    const q = path.match(/^\\/quotes\\/([^/]+)$/);
    if (q && method === 'PUT') {
      const symbol = normalizeSymbol(decodeURIComponent(q[1]));
      const price = Number(body.price);
      if (!Number.isFinite(price) || price < 0) return json({ error: '现价要是一个 ≥ 0 的数字' }, 400);
      demo.quotes[symbol] = price;
      demo.quoteAt[symbol] = new Date().toISOString().slice(0, 19).replace('T', ' ');
      saveDemo(demo);
      return json({ ok: true, symbol, price });
    }

    return json({ error: '接口不存在' }, 404);
  } catch (e) {
    if (e && e.status) return json({ error: e.error }, e.status);
    throw e;
  }
};
`;
}

/**
 * 演示数据 —— 全是编的，只为把五种状态各展示一遍：
 *   腾讯    两次买入 + 部分卖出       → 在持，且有已实现盈亏
 *   阿里    一次买入                 → 在持，浮亏
 *   京东    买入后全部卖出            → 已清仓，亏损
 *   百度    一次买入                 → 在持，浮盈
 *   中芯国际 买入→清仓→再买回来        → 第 2 轮持仓。摊薄成本从第 2 轮建仓那天
 *                                     重新起算，第 1 轮赚的钱单独报，不压低这一轮
 *
 * ⚠️ 刻意用众所周知的大盘股，不要放真实持仓 —— 这是公开页面。
 */
function seedData() {
  const trades = [
    { id: 1, symbol: '00700', name: '腾讯控股', side: 'BUY', trade_date: '2026-03-12', price: 372.4, qty: 100, fee: 62 },
    { id: 2, symbol: '09618', name: '京东集团-SW', side: 'BUY', trade_date: '2026-04-02', price: 131.5, qty: 400, fee: 58 },
    { id: 3, symbol: '00700', name: '腾讯控股', side: 'BUY', trade_date: '2026-05-08', price: 405.0, qty: 100, fee: 68 },
    { id: 4, symbol: '09988', name: '阿里巴巴-W', side: 'BUY', trade_date: '2026-05-20', price: 112.8, qty: 500, fee: 55 },
    { id: 5, symbol: '09618', name: '京东集团-SW', side: 'SELL', trade_date: '2026-06-18', price: 122.4, qty: 400, fee: 71, note: '止损清仓' },
    { id: 6, symbol: '00700', name: '腾讯控股', side: 'SELL', trade_date: '2026-07-24', price: 468.6, qty: 100, fee: 79, note: '减半仓' },
    { id: 7, symbol: '09888', name: '百度集团-SW', side: 'BUY', trade_date: '2026-08-11', price: 88.5, qty: 600, fee: 46 },
    { id: 8, symbol: '00981', name: '中芯国际', side: 'BUY', trade_date: '2026-02-10', price: 41.2, qty: 1000, fee: 52 },
    { id: 9, symbol: '00981', name: '中芯国际', side: 'SELL', trade_date: '2026-04-28', price: 56.8, qty: 1000, fee: 88, note: '整轮兑现' },
    { id: 10, symbol: '00981', name: '中芯国际', side: 'BUY', trade_date: '2026-07-15', price: 62.0, qty: 500, fee: 41, note: '回调再建仓' },
  ].map((t) => ({ note: '', created_at: t.trade_date + ' 10:00:00', ...t }));

  const at = '2026-09-03 09:30:00';
  return {
    trades,
    quotes: { '00700': 502.5, '09988': 106.2, '09888': 95.4, '00981': 68.9 },
    quoteAt: { '00700': at, '09988': at, '09888': at, '00981': at },
    costMode: 'avg',
  };
}

/**
 * 剥干净了没有。漏一条 import 就会和内联进来的同名函数撞成
 * 「Identifier 'x' has already been declared」—— 整段 script 不执行、页面全白，
 * 而构建本身照样成功。这个断言就是为了不让那种事再发生一次。
 */
function assertStripped(mods) {
  for (const [name, src] of Object.entries(mods)) {
    const bad = src.match(/^[ \t]*(?:import|export)\b.*/m);
    if (bad) throw new Error(`${name}.js 里还留着没剥掉的模块语句：\n  ${bad[0].trim()}`);
  }
}

/** 三个模块拼进同一个作用域，顶层重名会静默覆盖 —— 构建时就要发现 */
function assertNoCollisions(mods) {
  const seen = new Map();
  const dup = [];
  for (const [name, src] of Object.entries(mods)) {
    for (const m of src.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      const id = m[1];
      if (seen.has(id)) dup.push(`${id}（${seen.get(id)} / ${name}）`);
      else seen.set(id, name);
    }
  }
  if (dup.length) throw new Error(`顶层标识符重名，拼在一起会互相覆盖：\n  ${dup.join('\n  ')}`);
  console.log(`  顶层标识符 ${seen.size} 个，无重名 ✓`);
}
