/**
 * 港股买卖记录 · 记账核心
 *
 * 这个文件同时被服务端（写入校验）和浏览器（看板计算）import，
 * 保证两边永远算出同一个数字。改这里就够了，不要复制第二份。
 *
 * 两种成本口径，由 buildPortfolio 的 mode 参数选，看板和持仓页共用同一个：
 *
 *   avg  持仓成本 —— 移动加权平均成本 (moving weighted average cost)
 *     买入  数量 += q      成本 += q*单价 + 费用      均价 = 成本/数量
 *     卖出  结转成本 = 均价 * q
 *           已实现盈亏 += (q*单价 - 费用) - 结转成本
 *           数量 -= q      成本 -= 结转成本           均价不变
 *
 *   diluted  摊薄成本 —— 摊薄成本价 / 保本价 (diluted, break-even cost basis)
 *     成本 = 本轮买入金额 + 本轮全部费用 - 本轮卖出金额
 *     均价 = 成本 / 持仓数量       含义是「涨回这个价就回本」
 *     本轮的已实现盈亏摊进剩余持仓
 *
 * 「轮」是这里的核心概念：一轮 = 从建仓（持仓 0 → 正）到清仓（打回 0）。
 * 清仓过一次，下次再买就是新的一轮，成本从头算 —— 上一轮赚的钱不该继续压低
 * 这一轮的成本，否则一只翻倍卖飞过的票会永远显示「早就回本了」。
 * avg 口径本来就是这个行为（清仓时 cost 归零），diluted 跟它对齐。
 *
 * ⚠️ 两种口径下**总盈亏必须完全相同** —— 换口径只是在挪已实现和浮动之间
 *    的那条线，不会凭空多赚或少赚。这是验算有没有写错最好用的一把尺子，
 *    动过这里之后一定要拿同一批交易复核一遍。
 *    （摊薄下 realizedPnl 是**之前几轮**的合计，不是 0；本轮那部分才在成本里）
 *
 * ⚠️ 摊薄只对**还持有的**股票成立。已清仓的（qty=0）没有剩余持仓可摊，
 *    两种口径都照常报已实现盈亏 —— 否则那部分收益会凭空消失。
 */

const EPS = 1e-9;

/**
 * 两种成本口径。⚠️ id 会存进数据库，不要改。
 * label / alias / blurb 是界面文案，放在这里是因为它们描述的就是下面那套算法，
 * 拆到 UI 层去写，算法改了文案不会跟着改。
 */
export const COST_MODES = {
  avg: {
    id: 'avg',
    label: '持仓成本',
    alias: '移动加权平均成本 · moving weighted average cost',
    blurb: '买入费用计入成本，卖出费用从卖出收入里扣，卖出不改变剩余持仓的均价。会计准则、券商月结单和报税用的都是这个口径。',
  },
  diluted: {
    id: 'diluted',
    label: '摊薄成本',
    alias: '摊薄成本价，也叫「保本价」「盈亏平衡成本」· diluted / break-even cost basis',
    blurb: '已实现盈亏整个摊回剩余持仓，均价的含义变成「涨回这个价就回本」，所以卖出赚了钱它会被拉低。同花顺、东方财富、大智慧一类看盘软件的「成本价」设置项。',
  },
};

export const DEFAULT_COST_MODE = 'avg';

/** 认不出来的一律退回默认，不抛错 —— 这个值来自数据库和请求体，两边都可能是旧的 */
export function normalizeCostMode(v) {
  const s = String(v ?? '');
  return Object.hasOwn(COST_MODES, s) ? s : DEFAULT_COST_MODE;
}

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
 * @param rawMode 成本口径，见 COST_MODES；认不出来的退回 avg
 */
export function buildPortfolio(trades, quotes = {}, rawMode = DEFAULT_COST_MODE) {
  const mode = normalizeCostMode(rawMode);
  const holdings = [];
  const closed = [];
  // 流水页要标建仓/清仓 —— 顺路在这一趟里算出来，不另走一遍
  const marks = {};

  let totalBuyIn = 0;   // 累计投入（所有买入的金额+费用）
  let totalFees = 0;

  for (const t of trades) {
    totalFees += num(t.fee);
    if (t.side === 'BUY') totalBuyIn += tradeGross(t) + num(t.fee);
  }

  for (const [symbol, list] of groupBySymbol(sortTrades(trades))) {
    let qty = 0;
    let cost = 0;
    let realized = 0;    // 这只股票历来的已实现盈亏，所有轮次加起来
    let boughtQty = 0;
    let soldQty = 0;
    let name = '';
    let lastDate = '';

    // ── 轮次：一轮 = 从建仓（持仓 0 → 正）到清仓（打回 0）
    let roundIndex = 0;      // 当前是第几轮，从 1 开始
    let openedAt = '';       // 本轮的建仓日
    let roundBuy = 0;        // 本轮买入金额，不含费用
    let roundSell = 0;       // 本轮卖出金额，不含费用
    let roundFees = 0;       // 本轮全部费用，买卖都算
    let roundSold = 0;       // 本轮卖出股数
    let roundRealized = 0;   // 本轮已实现盈亏
    let priorRealized = 0;   // 之前已经清掉的那几轮，加起来

    for (const t of list) {
      if (t.name) name = t.name;
      lastDate = t.trade_date;
      const q = num(t.qty);
      const p = num(t.price);
      const fee = num(t.fee);

      if (t.side === 'BUY') {
        // 从空仓买进 = 新的一轮建仓，本轮的账全部从零开始
        if (qty <= EPS) {
          roundIndex += 1;
          openedAt = t.trade_date;
          roundBuy = 0;
          roundSell = 0;
          roundFees = 0;
          roundSold = 0;
          roundRealized = 0;
          marks[t.id] = 'open';
        }
        qty += q;
        cost += q * p + fee;
        roundBuy += q * p;
        roundFees += fee;
        boughtQty += q;
      } else {
        const avg = qty > EPS ? cost / qty : 0;
        const costOut = avg * Math.min(q, qty);
        const gain = (q * p - fee) - costOut;
        realized += gain;
        roundRealized += gain;
        qty -= q;
        cost -= costOut;
        roundSell += q * p;
        roundFees += fee;
        roundSold += q;
        soldQty += q;
        if (qty <= EPS) {
          qty = 0;
          cost = 0;
          marks[t.id] = 'close';
          // 这一轮到此为止，收益归档 —— 下一轮的摊薄成本不能再把它算进去
          priorRealized += roundRealized;
          roundRealized = 0;
        }
      }
    }

    // 摊薄只对还持有的股票成立，而且**只算本轮**：清仓过一次就重新起算。
    // 已清仓的（qty=0）没有剩余持仓可摊，照常报已实现盈亏。
    const diluted = mode === 'diluted' && qty > EPS;
    const costBasis = diluted ? roundBuy + roundFees - roundSell : cost;
    const avgCost = qty > EPS ? costBasis / qty : 0;

    // ⚠️ 没填现价时按「实际买入成本」估市值，两种口径共用这一个数。
    //    这里要是跟着摊薄走，浮盈会算成 0，而摊薄模式下已实现本来也是 0 ——
    //    那笔已经赚到的钱就凭空消失了。
    const unitCost = qty > EPS ? cost / qty : 0;
    const rawQuote = quotes[symbol];
    const hasQuote = rawQuote !== undefined && rawQuote !== null && rawQuote !== '';
    const price = hasQuote ? num(rawQuote) : unitCost;
    const marketValue = qty * price;
    const unrealized = marketValue - costBasis;

    const row = {
      symbol,
      name: name || symbol,
      qty,
      avgCost,
      costBasis,
      price,
      hasQuote,
      marketValue,
      unrealizedPnl: unrealized,
      unrealizedPct: costBasis > EPS ? unrealized / costBasis : 0,
      // 摊薄成本已经 ≤ 0：本金全部收回，收益率没有分母可算
      costRecovered: diluted && costBasis <= EPS,
      // 摊薄下只剩「之前几轮」的 —— 本轮那部分在成本里了
      realizedPnl: diluted ? priorRealized : realized,
      // 本轮有过卖出，它的已实现盈亏被摊进了成本。界面上要说明，不能只显示个 0
      realizedFolded: diluted && roundSold > EPS,
      totalPnl: (diluted ? priorRealized : realized) + unrealized,
      boughtQty,
      soldQty,
      // 本轮建仓日与轮次。清仓过的股票再买回来就是第 2 轮，成本从那天重新算
      openedAt,
      roundIndex,
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
    // { [交易 id]: 'open' | 'close' } —— 流水页据此打建仓/清仓标
    marks,
    totals: {
      mode,
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
      // 摊薄模式下已实现盈亏被摊进成本的持仓数。看板上「已实现盈亏」那一栏
      // 要据此说明，否则数字凭空变小、看起来像丢了记录
      foldedCount: holdings.filter((h) => h.realizedFolded).length,
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
