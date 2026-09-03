/**
 * 港股买卖记录 · 记账核心
 *
 * 这个文件同时被 Worker（服务端校验）和浏览器（看板计算）import，
 * 保证两边永远算出同一个数字。改这里就够了，不要复制第二份。
 *
 * 成本法：移动加权平均
 *   买入  数量 += q      成本 += q*单价 + 费用      均价 = 成本/数量
 *   卖出  结转成本 = 均价 * q
 *         已实现盈亏 += (q*单价 - 费用) - 结转成本
 *         数量 -= q      成本 -= 结转成本           均价不变
 */

const EPS = 1e-9;

/** 港股代码归一化：700 / 0700 / 00700.HK / hk00700 → 00700 */
export function normalizeSymbol(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) return '';
  const digits = s.replace(/\.HK$/, '').replace(/^HK/, '');
  if (/^\d{1,5}$/.test(digits)) return digits.padStart(5, '0');
  return s;
}

/** 一笔交易的现金流向：买入为负（付出），卖出为正（收到） */
export function tradeAmount(trade) {
  const gross = num(trade.qty) * num(trade.price);
  const fee = num(trade.fee);
  return trade.side === 'BUY' ? -(gross + fee) : gross - fee;
}

/** 一笔交易的成交金额（不含费用），即用户说的「总价」 */
export function tradeGross(trade) {
  return num(trade.qty) * num(trade.price);
}

/** 按时间排序：先按交易日，同日按录入顺序（id） */
export function sortTrades(trades) {
  return [...trades].sort((a, b) => {
    if (a.trade_date !== b.trade_date) return a.trade_date < b.trade_date ? -1 : 1;
    return num(a.id) - num(b.id);
  });
}

/**
 * 校验时间线：任何一刻都不能卖出超过当时的持仓。
 * @returns {null | {symbol: string, trade: object, held: number}} 没问题返回 null
 */
export function findOversell(trades) {
  for (const [symbol, list] of groupBySymbol(sortTrades(trades))) {
    let qty = 0;
    for (const t of list) {
      const q = num(t.qty);
      if (t.side === 'BUY') {
        qty += q;
      } else {
        if (q > qty + EPS) return { symbol, trade: t, held: qty };
        qty -= q;
      }
    }
  }
  return null;
}

/**
 * 汇总成看板需要的一切。
 * @param trades 全部交易
 * @param quotes { [symbol]: price } 手动维护的现价
 */
export function buildPortfolio(trades, quotes = {}) {
  const holdings = [];
  const closed = [];

  let totalBuyIn = 0;   // 累计投入（所有买入的金额+费用）
  let totalFees = 0;

  for (const t of trades) {
    totalFees += num(t.fee);
    if (t.side === 'BUY') totalBuyIn += tradeGross(t) + num(t.fee);
  }

  for (const [symbol, list] of groupBySymbol(sortTrades(trades))) {
    let qty = 0;
    let cost = 0;
    let realized = 0;
    let boughtQty = 0;
    let soldQty = 0;
    let name = '';
    let lastDate = '';

    for (const t of list) {
      if (t.name) name = t.name;
      lastDate = t.trade_date;
      const q = num(t.qty);
      const p = num(t.price);
      const fee = num(t.fee);

      if (t.side === 'BUY') {
        qty += q;
        cost += q * p + fee;
        boughtQty += q;
      } else {
        const avg = qty > EPS ? cost / qty : 0;
        const closedQty = Math.min(q, qty);
        const costOut = avg * closedQty;
        realized += (q * p - fee) - costOut;
        qty -= q;
        cost -= costOut;
        soldQty += q;
        if (qty <= EPS) { qty = 0; cost = 0; }
      }
    }

    const avgCost = qty > EPS ? cost / qty : 0;
    const rawQuote = quotes[symbol];
    const hasQuote = rawQuote !== undefined && rawQuote !== null && rawQuote !== '';
    const price = hasQuote ? num(rawQuote) : avgCost;   // 没填现价就按成本价估，浮盈显示为 0
    const marketValue = qty * price;
    const unrealized = marketValue - cost;

    const row = {
      symbol,
      name: name || symbol,
      qty,
      avgCost,
      costBasis: cost,
      price,
      hasQuote,
      marketValue,
      unrealizedPnl: unrealized,
      unrealizedPct: cost > EPS ? unrealized / cost : 0,
      realizedPnl: realized,
      totalPnl: realized + unrealized,
      boughtQty,
      soldQty,
      lastDate,
      tradeCount: list.length,
    };

    if (qty > EPS) holdings.push(row); else closed.push(row);
  }

  holdings.sort((a, b) => b.marketValue - a.marketValue);
  closed.sort((a, b) => (a.lastDate < b.lastDate ? 1 : -1));

  const costBasis = sum(holdings, (h) => h.costBasis);
  const marketValue = sum(holdings, (h) => h.marketValue);
  const unrealizedPnl = marketValue - costBasis;
  const realizedPnl = sum(holdings, (h) => h.realizedPnl) + sum(closed, (c) => c.realizedPnl);
  const totalPnl = realizedPnl + unrealizedPnl;

  return {
    holdings,
    closed,
    totals: {
      costBasis,
      marketValue,
      unrealizedPnl,
      unrealizedPct: costBasis > EPS ? unrealizedPnl / costBasis : 0,
      realizedPnl,
      totalPnl,
      totalPct: totalBuyIn > EPS ? totalPnl / totalBuyIn : 0,
      totalBuyIn,
      totalFees,
      holdingCount: holdings.length,
      closedCount: closed.length,
      tradeCount: trades.length,
      // 没填现价的持仓：市值口径不准，界面上要提示
      missingQuotes: holdings.filter((h) => !h.hasQuote).map((h) => h.symbol),
    },
  };
}

function groupBySymbol(trades) {
  const map = new Map();
  for (const t of trades) {
    const key = t.symbol;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  return map;
}

function sum(list, pick) {
  let total = 0;
  for (const item of list) total += pick(item);
  return total;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
