/**
 * 常用港股速查表。
 *
 * 目的只有一个：少记代码。在「股票代码」框里打「小米」也能带出 01810，
 * 名称跟着自动填好。表里没有的照样能手打代码，不受影响。
 *
 * 要加新的就照抄一行：
 *   symbol  5 位补零的港股代码
 *   name    默认名称（录入时随时能改，改了以这笔为准）
 *   aliases 你顺手会打的简称，中英文都行，小写即可
 *
 * ⚠️ 加之前先核对代码，填错了这只股票的所有记录都会算到别人头上。
 */
export const COMMON_STOCKS = [
  { symbol: '00700', name: '腾讯控股',     aliases: ['腾讯', 'tencent'] },
  { symbol: '09988', name: '阿里巴巴-W',   aliases: ['阿里', '阿里巴巴', 'alibaba', 'baba'] },
  { symbol: '03690', name: '美团-W',       aliases: ['美团', 'meituan'] },
  { symbol: '09618', name: '京东集团-SW',  aliases: ['京东', 'jd'] },
  { symbol: '09888', name: '百度集团-SW',  aliases: ['百度', 'baidu'] },
  { symbol: '01810', name: '小米集团-W',   aliases: ['小米', 'xiaomi'] },
  { symbol: '03896', name: '金山云',       aliases: ['金山', 'kingsoft cloud', 'ksyun'] },
  // 2026-04-01 由「小鹏汽车-W」更名为「小鹏集团-W」，代码不变
  { symbol: '09868', name: '小鹏集团-W',   aliases: ['小鹏', '小鹏汽车', 'xpeng'] },
  { symbol: '01766', name: '中国中车',     aliases: ['中车', 'crrc'] },
];

const BY_SYMBOL = new Map(COMMON_STOCKS.map((s) => [s.symbol, s]));

/** 代码对应的常用名称，表里没有就返回 '' */
export function commonName(symbol) {
  return BY_SYMBOL.get(symbol)?.name ?? '';
}

/**
 * 按输入找股票：先当代码认，认不出再按名称/简称匹配。
 * @returns {{symbol: string, name: string} | null}
 */
export function findStock(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // 纯数字（或 00700.HK 这种）直接当代码
  const asCode = raw.toUpperCase().replace(/\.HK$/, '').replace(/^HK/, '');
  if (/^\d{1,5}$/.test(asCode)) {
    const padded = asCode.padStart(5, '0');
    return BY_SYMBOL.get(padded) ?? { symbol: padded, name: '' };
  }

  const q = raw.toLowerCase();
  const hit =
    COMMON_STOCKS.find((s) => s.name.toLowerCase() === q || s.aliases.some((a) => a === q)) ??
    COMMON_STOCKS.find((s) => s.name.toLowerCase().startsWith(q) || s.aliases.some((a) => a.startsWith(q))) ??
    COMMON_STOCKS.find((s) => s.name.toLowerCase().includes(q) || s.aliases.some((a) => a.includes(q)));

  return hit ? { symbol: hit.symbol, name: hit.name } : null;
}
