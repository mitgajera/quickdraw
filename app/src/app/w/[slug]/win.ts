/** A shared win, parsed from `/w/SOL-3.20x-4.20` (market, multiplier, payout). Anything else is rejected. */
export interface SharedWin { symbol: "SOL" | "BTC" | "ETH"; mult: string; payout: string }

export function parseWin(slug: string): SharedWin | null {
  const m = /^(SOL|BTC|ETH)-(\d{1,2}(?:\.\d{1,2})?)x-(\d{1,5}(?:\.\d{2})?)$/.exec(decodeURIComponent(slug));
  return m ? { symbol: m[1] as SharedWin["symbol"], mult: m[2]!, payout: m[3]! } : null;
}

export const winSlug = (symbol: string, multBps: number, payout: bigint) =>
  `${symbol}-${(multBps / 1e4).toFixed(2)}x-${(Number(payout) / 1e6).toFixed(2)}`;
