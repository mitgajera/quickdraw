// Mirror of the on-chain odds (window touch pricing) (programs/quickdraw/src/odds.rs, state.rs, instructions/tap.rs), so
// the grid shows the multiplier the program will actually give.
import type { Book, Candles, Market } from "./accounts";
import { CANDLE_SLOTS, MAX_AHEAD_SECS, MIN_VOL_SAMPLES, ONE_X_BPS, TAP_LOCK_SECS, VOL_WINDOW_SECS, DRIFT_VOL_SCALE, WINDOW_VOL_SCALE } from "./constants";

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

export function sigmaFor(market: Market, candles: Candles | null, now: number): number {
  const est = candles ? sigmaFromCandles(candles, now) ?? 0 : 0;
  return Math.max(est, Number(market.sigmaFloor));
}

export interface Box { bandIndex: bigint; column: number; lo: bigint; hi: bigint; start: number; end: number }

export function boxAt(market: Market, bandIndex: bigint, column: number): Box {
  const lo = bandIndex * market.band;
  const start = column * market.colSecs;
  return { bandIndex, column, lo, hi: lo + market.band - 1n, start, end: start + market.colSecs };
}

export type QuoteResult =
  | { ok: true; multBps: number }
  | { ok: false; reason: "locked" | "too-far" | "unpriced" | "range" };

/** What the program would offer for `box` right now (same checks as `quote` in tap.rs). */
export function quoteBox(book: Book, box: Box, price: bigint, now: number, sigma: number): QuoteResult {
  const lead = box.start - now;
  if (lead < TAP_LOCK_SECS) return { ok: false, reason: "locked" };
  if (lead > MAX_AHEAD_SECS) return { ok: false, reason: "too-far" };
  const p = windowTouchProbability(price, box.lo, box.hi, lead, box.end - box.start, sigma * DRIFT_VOL_SCALE, sigma * WINDOW_VOL_SCALE);
  const m = multiplierBps(p, book.edgeBps);
  if (m === null) return { ok: false, reason: "unpriced" };
  if (m < book.minMultBps || m > book.maxMultBps) return { ok: false, reason: "range" };
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
