import {
  buildPortfolio, normalizeSymbol, tradeGross,
  COST_MODES, DEFAULT_COST_MODE, normalizeCostMode,
} from './accounting.js';
import { COMMON_STOCKS, findStock, commonName } from './stocks.js';

const $ = (sel) => document.querySelector(sel);
const el = {
  app: $('#app'),
  who: $('#who'),
  sheet: $('#sheet'),
  form: $('#trade-form'),
  formError: $('#form-error'),
  sheetTitle: $('#sheet-title'),
  sheetSave: $('#sheet-save'),
  sheetDelete: $('#sheet-delete'),
  totalPreview: $('#total-preview'),
  toast: $('#toast'),
  filter: $('#trade-filter'),
};

const state = {
  user: null,
  trades: [],
  quotes: {},
  quoteMeta: {},
  // { [交易 id]: 'open' | 'close' }，由 buildPortfolio 算出，流水页据此打标
  marks: {},
  // 成本口径。存在服务端跟着人走，所以手机和电脑看到的成本价是同一个
  costMode: DEFAULT_COST_MODE,
  editingId: null,
  filter: '',
};

/* ---------------------------------------------------------------- 启动 */

boot();

/**
 * 应用自己不做登录 —— 走到这一步说明前面的反向代理已经问过 IdP 并放行了。
 * /api/me 只是把代理注入的身份读回来显示在顶栏。
 */
async function boot() {
  const logout = $('#logout');
  // 服务端没注入 LOGOUT_URL 时占位符原样留着，那就别显示这个按钮
  const logoutUrl = logout?.getAttribute('href') || '';
  const hasLogout = logoutUrl && !logoutUrl.startsWith('__');
  if (logout) logout.hidden = !hasLogout;

  try {
    const { user } = await api('GET', '/api/me');
    state.user = user;
    el.app.hidden = false;
    el.who.textContent = user.name;
    await refresh();
  } catch (err) {
    document.body.innerHTML =
      `<div class="empty" style="margin:80px 20px">${esc(err.message)}` +
      (hasLogout ? `<br><br><a href="${esc(logoutUrl)}">去登录</a>` : '') +
      '</div>';
  }
}

async function refresh() {
  const data = await api('GET', '/api/state');
  state.trades = data.trades;
  state.names = null; // 下次 nameOf 时重建
  state.quotes = data.quotes;
  state.quoteMeta = Object.fromEntries((data.quoteMeta || []).map((q) => [q.symbol, q.updated_at]));
  state.costMode = normalizeCostMode(data.costMode);
  render();
}

/* ---------------------------------------------------------------- 渲染 */

function render() {
  const p = buildPortfolio(state.trades, state.quotes, state.costMode);
  state.marks = p.marks;   // renderTrades 也会被筛选框单独调用，所以存下来
  renderCostMode();
  renderBoard(p);
  renderHoldings(p);
  renderTrades();
  renderSymbolOptions();
}

/** 切换控件的选中态 + 底下那段说明。文案在 accounting.js 里，和算法放在一起 */
function renderCostMode() {
  const meta = COST_MODES[state.costMode] || COST_MODES[DEFAULT_COST_MODE];
  document.querySelectorAll('#cost-mode button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === meta.id));
  });
  $('#cost-mode-alias').textContent = meta.alias;
  $('#cost-mode-blurb').textContent = meta.blurb;
}

function renderBoard({ holdings, closed, totals }) {
  setSigned('#k-total', totals.totalPnl, { hero: true });
  $('#k-total-pct').textContent = totals.tradeCount ? signedPct(totals.totalPct) + '   ·   累计投入回报' : '还没有记录';
  $('#k-total-pct').className = 'hero-sub ' + toneOf(totals.totalPnl);

  $('#k-mv').textContent = money(totals.marketValue);
  $('#k-cost').textContent = money(totals.costBasis);
  $('#k-cost-label').textContent = (COST_MODES[totals.mode] || COST_MODES[DEFAULT_COST_MODE]).label;

  setSigned('#k-unreal', totals.unrealizedPnl);
  $('#k-unreal-pct').textContent = totals.costBasis > 0
    ? signedPct(totals.unrealizedPct)
    : (totals.holdingCount ? '成本已收回' : '');

  // 摊薄口径下，持仓那部分的已实现盈亏被摊进了成本。数字凭空变小很像丢了记录，
  // 所以这里必须说清楚剩下的是什么 —— 而不是把这一栏藏起来。
  if (totals.foldedCount && !closed.length) {
    $('#k-real').textContent = '已摊入成本';
    $('#k-real').className = 'kpi-value flat';
    $('#k-real-sub').textContent = `${totals.foldedCount} 只持仓`;
  } else {
    setSigned('#k-real', totals.realizedPnl);
    $('#k-real-sub').textContent = totals.foldedCount
      ? `仅 ${closed.length} 只已清仓 · 持仓部分已摊入成本`
      : (closed.length ? `${closed.length} 只已清仓` : '');
  }

  $('#k-buyin').textContent = money(totals.totalBuyIn);
  $('#k-fees').textContent = money(totals.totalFees);

  const warn = $('#quote-warning');
  if (totals.missingQuotes.length) {
    warn.hidden = false;
    warn.textContent =
      `${totals.missingQuotes.join('、')} 还没填现价，暂时按成本价计入市值（浮盈算作 0）。到「持仓」页填一下就准了。`;
  } else {
    warn.hidden = true;
  }

  // 持仓分布
  const alloc = $('#allocation');
  if (!holdings.length) {
    alloc.innerHTML = emptyBox('还没有持仓');
  } else {
    const max = Math.max(...holdings.map((h) => h.marketValue), 1);
    alloc.innerHTML = holdings
      .map((h) => {
        const share = totals.marketValue > 0 ? h.marketValue / totals.marketValue : 0;
        return `<div class="alloc-row">
          <div class="alloc-head">
            <span>${esc(h.name)} <span class="muted">${esc(h.symbol)}</span></span>
            <span class="num">${money(h.marketValue)} <span class="muted">${pct(share)}</span></span>
          </div>
          <div class="alloc-bar"><div class="alloc-fill" style="width:${(h.marketValue / max) * 100}%"></div></div>
        </div>`;
      })
      .join('');
  }

  // 已清仓
  const closedBox = $('#closed-list');
  closedBox.innerHTML = closed.length
    ? closed
        .map(
          (c) => `<div class="card">
            <div class="card-head">
              <div class="sym">${esc(c.name)}<span class="code">${esc(c.symbol)}</span></div>
              <div class="row-figure ${toneOf(c.realizedPnl)}">${signed(c.realizedPnl)}</div>
            </div>
            <div class="row-sub">买入 ${qty(c.boughtQty)} 股 · 卖出 ${qty(c.soldQty)} 股${c.roundIndex > 1 ? ` · 共 ${c.roundIndex} 轮` : ''} · 清仓 ${c.lastDate}</div>
          </div>`
        )
        .join('')
    : emptyBox('还没有完全卖出的股票');
}

function renderHoldings({ holdings }) {
  const box = $('#holdings-list');
  if (!holdings.length) {
    box.innerHTML = emptyBox('还没有持仓，点右下角 ＋ 记一笔买入');
    return;
  }

  box.innerHTML = holdings
    .map(
      (h) => `<div class="card">
        <div class="card-head">
          <div class="sym">${esc(h.name)}<span class="code">${esc(h.symbol)}</span></div>
          <div>
            <div class="row-figure ${toneOf(h.unrealizedPnl)}">${signed(h.unrealizedPnl)}</div>
            <div class="row-sub ${toneOf(h.unrealizedPnl)}" style="text-align:right">${pctLine(h)}</div>
          </div>
        </div>
        <dl class="stat-row">
          <div class="stat"><dt>持有 (股)</dt><dd>${qty(h.qty)}</dd></div>
          <div class="stat"><dt>均价</dt><dd>${plain(h.avgCost, 3)}</dd></div>
          <div class="stat"><dt>成本</dt><dd>${plain(h.costBasis)}</dd></div>
          <div class="stat"><dt>市值</dt><dd>${plain(h.marketValue)}</dd></div>
        </dl>
        ${cardFooter(h)}
        <div class="pos-price">
          <span>当前价</span>
          <input type="number" step="0.001" min="0" inputmode="decimal"
                 data-quote="${esc(h.symbol)}" value="${h.hasQuote ? h.price : ''}" placeholder="填入现价">
          <span class="stamp muted">${state.quoteMeta[h.symbol] ? '更新于 ' + shortTime(state.quoteMeta[h.symbol]) : ''}</span>
        </div>
      </div>`
    )
    .join('');
}

/** 持仓卡右上角那行百分比 */
function pctLine(h) {
  if (!h.hasQuote) return '待填现价';
  // 摊薄成本已经 ≤ 0：本金全部收回，收益率没有分母，硬报一个只会是天文数字
  if (h.costRecovered) return '成本已收回';
  return signedPct(h.unrealizedPct);
}

/**
 * 持仓卡底部的说明区：建仓日 / 轮次 / 已实现盈亏。
 * 合成一个块统一给间距 —— 行数是会变的，每条各带一个 margin 迟早对不齐。
 */
function cardFooter(h) {
  const lines = [];

  const meta = [];
  if (h.openedAt) meta.push(`建仓 ${esc(h.openedAt)}`);
  // 清仓过又买回来的才标轮次，第 1 轮说「第 1 轮」是废话
  if (h.roundIndex > 1) meta.push(`第 ${h.roundIndex} 轮`);
  if (meta.length) lines.push(meta.join('　·　'));

  if (h.realizedFolded && h.realizedPnl !== 0) {
    // 摊薄：本轮的摊进成本了，之前几轮的还实实在在赚着，要单独报
    lines.push(
      `前 ${h.roundIndex - 1} 轮已实现 <span class="${toneOf(h.realizedPnl)}">${signed(h.realizedPnl)}</span>` +
      '　·　本轮已摊入成本'
    );
  } else if (h.realizedFolded) {
    // 这个 0 的含义是「摊进成本了」，不是「没赚过」
    lines.push('这只已实现盈亏 <span class="muted">已摊入成本</span>');
  } else if (h.realizedPnl !== 0) {
    lines.push(`这只已实现盈亏 <span class="${toneOf(h.realizedPnl)}">${signed(h.realizedPnl)}</span>`);
  }

  return lines.length ? `<div class="pos-meta">${lines.map((l) => `<div>${l}</div>`).join('')}</div>` : '';
}

function renderTrades() {
  const box = $('#trades-list');
  const q = state.filter.trim().toLowerCase();
  const list = q
    ? state.trades.filter((t) => t.symbol.toLowerCase().includes(q) || nameOf(t.symbol).toLowerCase().includes(q))
    : state.trades;

  if (!list.length) {
    box.innerHTML = emptyBox(q ? '没有匹配的记录' : '还没有交易记录');
    return;
  }

  let html = '';
  let lastDate = null;
  for (const t of list) {
    if (t.trade_date !== lastDate) {
      lastDate = t.trade_date;
      html += `<div class="trade-day">${t.trade_date}</div>`;
    }
    const buy = t.side === 'BUY';
    const gross = tradeGross(t);
    const net = buy ? gross + Number(t.fee) : gross - Number(t.fee);
    // 建仓 = 持仓从 0 变成正数的那笔；清仓 = 把持仓打回 0 的那笔。
    // 摊薄成本就是从建仓那天重新起算的，所以这两个点值得在流水里看得见。
    const mark = state.marks[t.id];
    html += `<button class="trade" data-trade="${t.id}">
      <span class="pill ${buy ? 'buy' : 'sell'}">${buy ? '买' : '卖'}</span>
      <span class="trade-main">
        <span class="line1"><strong>${esc(nameOf(t.symbol))}</strong>${nameOf(t.symbol) === t.symbol ? '' : `<span class="muted">${esc(t.symbol)}</span>`}${mark ? `<span class="round-tag ${mark}">${mark === 'open' ? '建仓' : '清仓'}</span>` : ''}</span>
        <span class="line2">${plain(t.price, 3)} × ${qty(t.qty)} 股${Number(t.fee) ? ' · 费用 ' + plain(t.fee) : ''}${t.note ? ' · ' + esc(t.note) : ''}</span>
      </span>
      <span class="trade-right">
        <span class="amount ${buy ? 'up' : 'down'}">${buy ? '−' : '+'}${money(Math.abs(net))}</span>
      </span>
    </button>`;
  }
  box.innerHTML = html;
}

/**
 * 下拉候选 = 交易过的 + 常用表。
 *
 * option 的 value 写成「01810 小米集团-W」而不是纯代码：浏览器只按 value 过滤，
 * 名称不放进 value 的话，打「小米」就什么都匹配不到。选中后由
 * resolveSymbolField 再把它还原成纯代码。
 */
function renderSymbolOptions() {
  const seen = new Map();
  for (const t of state.trades) seen.set(t.symbol, nameOf(t.symbol));
  for (const s of COMMON_STOCKS) if (!seen.has(s.symbol)) seen.set(s.symbol, s.name);

  $('#symbol-options').innerHTML = [...seen]
    .map(([sym, name]) => `<option value="${esc(name && name !== sym ? sym + ' ' + name : sym)}"></option>`)
    .join('');
}

/** 某只股票的名称：交易记录里填过的优先，其次常用表，都没有就退回代码 */
function nameOf(symbol) {
  if (!state.names) {
    state.names = new Map();
    for (const t of state.trades) if (t.name && !state.names.has(t.symbol)) state.names.set(t.symbol, t.name);
  }
  return state.names.get(symbol) || commonName(symbol) || symbol;
}

/**
 * 把代码框里的东西解析成 { symbol, name }。接受三种写法：
 *   「01810 小米集团-W」 从下拉里选的
 *   「小米」/「xpeng」   常用表里的名称或简称
 *   「700」/「00700.HK」 直接打代码
 */
function parseSymbolInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  // 下拉选中的那种，前面是代码后面是名称
  const picked = s.match(/^(\d{1,5})\s+(.+)$/);
  if (picked) return { symbol: normalizeSymbol(picked[1]), name: picked[2].trim(), known: true };

  const hit = findStock(s);
  if (hit && hit.name) return { ...hit, known: true };
  if (hit) return { ...hit, name: nameOf(hit.symbol) === hit.symbol ? '' : nameOf(hit.symbol), known: true };

  // 认不出来的当代码收着 —— 表里没有的股票照样能记
  const symbol = normalizeSymbol(s);
  const known = /^\d{5}$/.test(symbol);
  return { symbol, name: known ? nameOf(symbol).replace(symbol, '') : '', known };
}

/** 代码框失焦/选中后：还原成纯代码、补名称、给一行确认提示 */
function resolveSymbolField() {
  const input = $('#f-symbol');
  const hint = $('#symbol-hint');
  const parsed = parseSymbolInput(input.value);

  if (!parsed) {
    hint.textContent = '';
    hint.className = 'field-hint';
    return;
  }

  input.value = parsed.symbol;

  const name = parsed.name || nameOf(parsed.symbol);
  if (name && name !== parsed.symbol && !$('#f-name').value.trim()) $('#f-name').value = name;

  if (!parsed.known) {
    hint.textContent = '没认出来 —— 请改填数字代码，或把它加进常用表';
    hint.className = 'field-hint bad';
  } else if (name && name !== parsed.symbol) {
    hint.textContent = `${parsed.symbol}　${name}`;
    hint.className = 'field-hint ok';
  } else {
    hint.textContent = parsed.symbol;
    hint.className = 'field-hint ok';
  }

  updateTotalPreview();
}

/* ------------------------------------------------------------ 交互绑定 */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach((p) => {
      p.classList.toggle('active', p.dataset.panel === tab.dataset.tab);
    });
    window.scrollTo({ top: 0 });
  });
});

el.filter.addEventListener('input', () => {
  state.filter = el.filter.value;
  renderTrades();
});

// 现价：停止输入 500ms 后自动保存
const quoteTimers = new Map();
$('#holdings-list').addEventListener('input', (e) => {
  const input = e.target.closest('[data-quote]');
  if (!input) return;
  const symbol = input.dataset.quote;
  clearTimeout(quoteTimers.get(symbol));
  quoteTimers.set(
    symbol,
    setTimeout(async () => {
      const raw = input.value.trim();
      if (raw === '') return;
      try {
        await api('PUT', `/api/quotes/${encodeURIComponent(symbol)}`, { price: Number(raw) });
        state.quotes[symbol] = Number(raw);
        state.quoteMeta[symbol] = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const p = buildPortfolio(state.trades, state.quotes, state.costMode);
        renderBoard(p);
        updateHoldingCard(symbol, p);
      } catch (err) {
        toast(err.message, true);
      }
    }, 500)
  );
});

/** 只刷新一张持仓卡的数字，避免把用户正在打字的输入框重建掉 */
function updateHoldingCard(symbol, portfolio) {
  const h = portfolio.holdings.find((x) => x.symbol === symbol);
  const input = document.querySelector(`[data-quote="${CSS.escape(symbol)}"]`);
  if (!h || !input) return;
  const card = input.closest('.card');
  card.querySelector('.row-figure').className = 'row-figure ' + toneOf(h.unrealizedPnl);
  card.querySelector('.row-figure').textContent = signed(h.unrealizedPnl);
  const sub = card.querySelector('.card-head .row-sub');
  sub.className = 'row-sub ' + toneOf(h.unrealizedPnl);
  sub.style.textAlign = 'right';
  sub.textContent = pctLine(h);
  card.querySelectorAll('.stat dd')[3].textContent = plain(h.marketValue);
  card.querySelector('.stamp').textContent = '刚刚更新';
}

// 成本口径：先切界面再存服务端，存不上就退回去
$('#cost-mode').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn || btn.dataset.mode === state.costMode) return;

  const prev = state.costMode;
  state.costMode = btn.dataset.mode;
  render();

  try {
    await api('PUT', '/api/settings', { costMode: state.costMode });
  } catch (err) {
    // 留在切换后的样子会让人以为已经记住了，下次打开又变回去，更难查
    state.costMode = prev;
    render();
    toast(err.message, true);
  }
});

$('#trades-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-trade]');
  if (btn) openSheet(state.trades.find((t) => String(t.id) === btn.dataset.trade));
});

$('#add-trade').addEventListener('click', () => openSheet(null));
$('#sheet-cancel').addEventListener('click', closeSheet);
el.sheet.addEventListener('click', (e) => {
  if (e.target === el.sheet) closeSheet();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.sheet.hidden) closeSheet();
});

el.form.addEventListener('input', updateTotalPreview);
el.form.addEventListener('change', updateTotalPreview);

// change 覆盖「从下拉里选」和「打完移开焦点」两种情况
$('#f-symbol').addEventListener('change', resolveSymbolField);
$('#f-symbol').addEventListener('blur', resolveSymbolField);

el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  el.formError.hidden = true;
  el.sheetSave.disabled = true;

  // 有可能没触发过 blur 就直接点了保存（比如键盘回车），这里兜一次
  resolveSymbolField();

  const body = {
    symbol: $('#f-symbol').value,
    name: $('#f-name').value,
    side: el.form.side.value,
    trade_date: $('#f-date').value,
    price: $('#f-price').value,
    qty: $('#f-qty').value,
    fee: $('#f-fee').value,
    note: $('#f-note').value,
  };

  try {
    if (state.editingId) {
      await api('PUT', `/api/trades/${state.editingId}`, body);
      toast('已保存');
    } else {
      await api('POST', '/api/trades', body);
      toast('已记录');
    }
    closeSheet();
    await refresh();
  } catch (err) {
    el.formError.textContent = err.message;
    el.formError.hidden = false;
  } finally {
    el.sheetSave.disabled = false;
  }
});

el.sheetDelete.addEventListener('click', async () => {
  if (!state.editingId) return;
  if (!confirm('删除这条交易记录？删掉之后盈亏会重新计算。')) return;
  el.sheetDelete.disabled = true;
  try {
    await api('DELETE', `/api/trades/${state.editingId}`);
    closeSheet();
    await refresh();
    toast('已删除');
  } catch (err) {
    el.formError.textContent = err.message;
    el.formError.hidden = false;
  } finally {
    el.sheetDelete.disabled = false;
  }
});

/* ---------------------------------------------------------------- 表单 */

function openSheet(trade) {
  el.form.reset();
  el.formError.hidden = true;
  state.editingId = trade ? trade.id : null;

  if (trade) {
    el.sheetTitle.textContent = '编辑交易';
    el.sheetDelete.hidden = false;
    el.form.side.value = trade.side;
    $('#f-symbol').value = trade.symbol;
    $('#f-name').value = trade.name || '';
    $('#f-date').value = trade.trade_date;
    $('#f-price').value = trade.price;
    $('#f-qty').value = trade.qty;
    $('#f-fee').value = Number(trade.fee) || '';
    $('#f-note').value = trade.note || '';
  } else {
    el.sheetTitle.textContent = '新增交易';
    el.sheetDelete.hidden = true;
    el.form.side.value = 'BUY';
    $('#f-date').value = todayHK();
  }

  $('#symbol-hint').textContent = '';
  $('#symbol-hint').className = 'field-hint';
  if (trade) resolveSymbolField();

  updateTotalPreview();
  el.sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  if (!trade) setTimeout(() => $('#f-symbol').focus(), 60);
}

function closeSheet() {
  el.sheet.hidden = true;
  state.editingId = null;
  document.body.style.overflow = '';
}

function updateTotalPreview() {
  const price = Number($('#f-price').value);
  const q = Number($('#f-qty').value);
  const fee = Number($('#f-fee').value) || 0;
  const buy = el.form.side.value === 'BUY';

  if (!Number.isFinite(price) || !Number.isFinite(q) || price <= 0 || q <= 0) {
    el.totalPreview.innerHTML = '填好单价和数量后，这里会显示总价';
    return;
  }

  const gross = price * q;
  const net = buy ? gross + fee : gross - fee;
  el.totalPreview.innerHTML =
    `总价 <strong>${money(gross)}</strong>` +
    (fee ? `　·　${buy ? '实付' : '实收'} <strong>${money(net)}</strong>（含费用 ${plain(fee)}）` : '');

  // 卖出时提示一下这笔大概能实现多少盈亏
  if (!buy) {
    const symbol = parseSymbolInput($('#f-symbol').value)?.symbol ?? '';
    const before = state.trades.filter((t) => t.symbol === symbol && t.id !== state.editingId);
    if (before.length) {
      // ⚠️ 这里刻意不跟成本口径走。要预估的是这笔卖出实际落袋多少，
      //    那取决于结转成本（移动加权平均），和看板显示哪个口径无关。
      const pos = buildPortfolio(before, {}).holdings.find((h) => h.symbol === symbol);
      if (pos && pos.qty > 0) {
        const realized = net - pos.avgCost * Math.min(q, pos.qty);
        el.totalPreview.innerHTML +=
          `<div class="row-sub" style="margin-top:6px">当前持有 ${qty(pos.qty)} 股，均价 ${plain(pos.avgCost, 3)}` +
          `　→　这笔实现盈亏约 <span class="${toneOf(realized)}">${signed(realized)}</span></div>`;
      }
    }
  }
}

/* ---------------------------------------------------------------- 工具 */

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  // 会话过期时 Caddy 会把请求 302 到 Authelia；fetch 拿到的会是登录页而不是 401。
  // 真收到 401 说明 Remote-User 头没进来 —— 刷新一次让浏览器走完整跳转。
  if (res.status === 401) {
    location.reload();
    throw new Error('登录已过期，正在重新登录…');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

let toastTimer;
function toast(message, bad = false) {
  el.toast.textContent = message;
  el.toast.className = 'toast' + (bad ? ' bad' : '');
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), bad ? 5000 : 2000);
}

function setSigned(sel, value, { hero = false } = {}) {
  const node = $(sel);
  node.textContent = signed(value);
  node.className = (hero ? 'hero-value ' : 'kpi-value ') + toneOf(value);
}

function toneOf(v) {
  if (v > 0.005) return 'up';
  if (v < -0.005) return 'down';
  return 'flat';
}

function money(v) {
  return 'HK$' + plain(v);
}

function plain(v, digits = 2) {
  return Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function signed(v) {
  const sign = v > 0.005 ? '+' : v < -0.005 ? '−' : '';
  return sign + 'HK$' + plain(Math.abs(v));
}

function signedPct(v) {
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return sign + pct(Math.abs(v));
}

function pct(v) {
  return (v * 100).toFixed(2) + '%';
}

function qty(v) {
  return Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/** 港股交易日按香港时区取，避免半夜录入记成第二天 */
function todayHK() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong' }).format(new Date());
}

function shortTime(iso) {
  return String(iso).replace('T', ' ').slice(5, 16);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function emptyBox(text) {
  return `<div class="empty">${esc(text)}</div>`;
}
