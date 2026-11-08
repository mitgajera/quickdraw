// Mirror of the on-chain odds (window touch pricing) (programs/quickdraw/src/odds.rs, state.rs, instructions/tap.rs), so
// the grid shows the multiplier the program will actually give.
import type { Book, Candles, Market } from "./accounts";
import { CALM_DRIFT_VOL_SCALE, CALM_FLOOR_RATIO, CALM_WINDOW_VOL_SCALE, CANDLE_SLOTS, MAX_AHEAD_SECS, MIN_VOL_SAMPLES, ONE_X_BPS, TAP_LOCK_SECS, VOL_WINDOW_SECS, DRIFT_VOL_SCALE, WINDOW_VOL_SCALE, MAX_ZOOM } from "./constants";

/** Complementary error function (Numerical Recipes `erfcc`), same constants as the program. */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const poly = -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
    + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
  const r = t * Math.exp(poly);
  return x >= 0 ? r : 2 - r;
}

export const normCdf = (z: number) => 0.5 * erfc(-z / Math.SQRT2);

/** Chance that a price at `price` touches `[lo, hi]` within `secs`, for per-second volatility `sigma`. */
export function touchProbability(price: bigint, lo: bigint, hi: bigint, secs: number, sigma: number): number {
  let distance: bigint;
  if (price < lo) distance = lo - price;
  else if (price > hi) distance = price - hi;
  else return 1;
  if (sigma <= 0 || secs <= 0) return 0;
  const z = Number(distance) / (sigma * Math.sqrt(secs));
  return Math.min(1, Math.max(0, 2 * (1 - normCdf(z))));
}

const GL_X = [0.12523340851146894, 0.3678314989981802, 0.5873179542866175, 0.7699026741943047, 0.9041172563704748, 0.9815606342467192];
const GL_W = [0.24914704581340288, 0.23349253653835458, 0.20316742672306584, 0.16007832854334633, 0.10693932599531818, 0.04717533638650846];
const INV_SQRT_2PI = 0.3989422804014327;
const Z_MAX = 7;
const REACH = 6;

const touchWithin = (z: number) => (z <= 0 ? 1 : erfc(z / Math.SQRT2));

function sideIntegral(a: number, b: number, dist: (z: number) => number): number {
  if (b <= a) return 0;
  const mid = (a + b) / 2, half = (b - a) / 2;
  let sum = 0;
  for (let i = 0; i < GL_X.length; i++) {
    for (const z of [mid - half * GL_X[i]!, mid + half * GL_X[i]!]) {
      sum += GL_W[i]! * INV_SQRT_2PI * Math.exp(-z * z / 2) * touchWithin(dist(z));
    }
  }
  return sum * half;
}

/**
 * Chance the price trades inside `[lo, hi]` during a window opening in `lead` s and lasting `window` s:
 * drift with `sigmaDrift` until it opens, wander with `sigmaWindow` inside it (same as odds.rs).
 */
export function windowTouchProbability(
  price: bigint, lo: bigint, hi: bigint, lead: number, window: number, sigmaDrift: number, sigmaWindow: number,
): number {
  if (sigmaDrift <= 0 || sigmaWindow <= 0 || window <= 0) return price >= lo && price <= hi ? 1 : 0;
  if (lead <= 0) return touchProbability(price, lo, hi, window, sigmaWindow);
  const s1 = sigmaDrift * Math.sqrt(lead);
  const ratio = s1 / (sigmaWindow * Math.sqrt(window));
  const zl = Number(lo - price) / s1;
  const zh = Number(hi - price) / s1;
  const inside = Math.max(0, normCdf(zh) - normCdf(zl));
  const reach = REACH / ratio;
  const below = sideIntegral(Math.max(zl - reach, -Z_MAX), Math.min(zl, Z_MAX), (z) => (zl - z) * ratio);
  const above = sideIntegral(Math.max(zh, -Z_MAX), Math.min(zh + reach, Z_MAX), (z) => (z - zh) * ratio);
  return Math.min(1, Math.max(0, inside + below + above));
}

export function multiplierBps(probability: number, edgeBps: number): number | null {
  if (probability <= 0 || edgeBps >= ONE_X_BPS) return null;
  const bps = (ONE_X_BPS - edgeBps) / probability;
  return Number.isFinite(bps) && bps < 2 ** 32 - 1 ? Math.floor(bps) : null;
}

const slotOf = (sec: number) => ((sec % CANDLE_SLOTS) + CANDLE_SLOTS) % CANDLE_SLOTS;

/** The (high, low) recorded for a second, if it is still in the ring. */
export function rangeAt(c: Candles, sec: number): [bigint, bigint] | null {
  const i = slotOf(sec);
  return c.secs[i] === BigInt(sec) ? [c.highs[i]!, c.lows[i]!] : null;
}

/** Per-second volatility from recorded midpoints in `(now - window, now]`. */
export function sigmaFromCandles(c: Candles, now: number, window = VOL_WINDOW_SECS): number | null {
  let prev: [number, number] | null = null;
  let sum = 0;
  let moves = 0;
  for (let sec = now - window + 1; sec <= now; sec++) {
    const r = rangeAt(c, sec);
    if (!r) continue;
    const mid = (Number(r[0]) + Number(r[1])) / 2;
    if (prev) { sum += (mid - prev[1]) ** 2 / (sec - prev[0]); moves++; }
    prev = [sec, mid];
  }
  return moves >= MIN_VOL_SAMPLES ? Math.sqrt(sum / moves) : null;
}

/** Volatility for the two pricing scenarios (see `quoteBox`). A plain number means both. */
export interface Sigma { jumpy: number; calm: number }
const asSigma = (s: Sigma | number): Sigma => (typeof s === "number" ? { jumpy: s, calm: s * CALM_FLOOR_RATIO } : s);

export function sigmaFor(market: Market, candles: Candles | null, now: number): Sigma {
  const est = candles ? sigmaFromCandles(candles, now) ?? 0 : 0;
  const floor = Number(market.sigmaFloor);
  return { jumpy: Math.max(est, floor), calm: Math.max(est, floor * CALM_FLOOR_RATIO) };
}

/** Same as `quote` in tap.rs: the likelier of the jumpy and calm scenarios. */
export function boxProbability(box: Box, price: bigint, now: number, sigma: Sigma | number): number {
  const s = asSigma(sigma), lead = box.start - now, w = box.end - box.start;
  return Math.max(
    windowTouchProbability(price, box.lo, box.hi, lead, w, s.jumpy * DRIFT_VOL_SCALE, s.jumpy * WINDOW_VOL_SCALE),
    windowTouchProbability(price, box.lo, box.hi, lead, w, s.calm * CALM_DRIFT_VOL_SCALE, s.calm * CALM_WINDOW_VOL_SCALE),
  );
}

export interface Box { bandIndex: bigint; column: number; zoom: number; lo: bigint; hi: bigint; start: number; end: number }

/** Row height at a zoom level: the market's base row doubled `zoom` times. */
export const rowHeight = (market: Market, zoom = 0) => market.band << BigInt(zoom);

export function boxAt(market: Market, bandIndex: bigint, column: number, zoom = 0): Box {
  const h = rowHeight(market, zoom);
  const lo = bandIndex * h;
  const start = column * market.colSecs;
  return { bandIndex, column, zoom, lo, hi: lo + h - 1n, start, end: start + market.colSecs };
}

/** Raw multiplier (bps, before range limits) for a box, or Infinity when it cannot be hit. */
function rawMultBps(book: Book, box: Box, price: bigint, now: number, sigma: Sigma | number): number {
  const p = boxProbability(box, price, now, sigma);
  return p > 0 ? (ONE_X_BPS - book.edgeBps) / p : Infinity;
}

/**
 * The zoom whose grid shows a real gradient right now: the box three rows above the price, two
 * columns out, should pay about `targetX` (calm markets zoom in, busy markets zoom out).
 */
export function idealZoom(market: Market, book: Book, price: bigint, now: number, sigma: Sigma | number, targetX = 10): number {
  let best = 0, bestErr = Infinity;
  const column = Math.floor(now / market.colSecs) + 2;
  for (let z = 0; z <= MAX_ZOOM; z++) {
    const row = price / rowHeight(market, z);
    const m = rawMultBps(book, boxAt(market, row + 3n, column, z), price, now, sigma) / ONE_X_BPS;
    const err = Math.abs(Math.log(Math.min(m, 1e6)) - Math.log(targetX));
    if (err < bestErr) { best = z; bestErr = err; }
  }
  return best;
}

export type QuoteResult =
  | { ok: true; multBps: number }
  | { ok: false; reason: "locked" | "too-far" | "unpriced" | "range" }
  | { ok: false; reason: "limit"; multBps: number };

/** Same check as `has_capacity` in tap.rs: open payouts stay within the book's exposure cap. */
export function hasCapacity(book: Book, stake: bigint, payout: bigint): boolean {
  return (book.exposure + payout) * BigInt(ONE_X_BPS) <= (book.liquidity + stake) * BigInt(book.maxExposureBps);
}

/**
 * What the program would offer for `box` right now (same checks as `quote` in tap.rs). With `stake`,
 * also the per-tap profit cap and the house's exposure cap, which reject a priced box as "limit".
 */
export function quoteBox(book: Book, box: Box, price: bigint, now: number, sigma: Sigma | number, stake?: bigint): QuoteResult {
  const lead = box.start - now;
  if (lead < TAP_LOCK_SECS) return { ok: false, reason: "locked" };
  if (lead > MAX_AHEAD_SECS) return { ok: false, reason: "too-far" };
  const p = boxProbability(box, price, now, sigma);
  const m = multiplierBps(p, book.edgeBps);
  if (m === null) return { ok: false, reason: "unpriced" };
  if (m < book.minMultBps || m > book.maxMultBps) return { ok: false, reason: "range" };
  if (stake !== undefined) {
    const payout = (stake * BigInt(m)) / BigInt(ONE_X_BPS);
    if (payout - stake > book.maxProfit || !hasCapacity(book, stake, payout)) return { ok: false, reason: "limit", multBps: m };
  }
  return { ok: true, multBps: m };
}

/** Lowest low / highest high recorded for the seconds `[start, end)`. */
export function windowRange(c: Candles, start: number, end: number): [bigint, bigint] | null {
  let out: [bigint, bigint] | null = null;
  for (let sec = start; sec < end; sec++) {
    const r = rangeAt(c, sec);
    if (!r) continue;
    out = out ? [r[1] < out[0] ? r[1] : out[0], r[0] > out[1] ? r[0] : out[1]] : [r[1], r[0]];
  }
  return out;
}

export type Outcome = "pending" | "win" | "lose" | "void";

/** Same rule as `Candles::judge`: continuous prices mean the window's [low, high] was all traded. */
export function judge(c: Candles, lo: bigint, hi: bigint, start: number, end: number, now: number): Outcome {
  const r = windowRange(c, start, Math.min(end, now + 1));
  if (r && r[1] >= lo && r[0] <= hi) return "win";
  if (now < end) return "pending";
  return r ? "lose" : "void";
}
