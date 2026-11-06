// Same cases as the Rust unit tests, so the client's odds and settlement match the program.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import type { Book, Candles, Market } from "./accounts";
import { CANDLE_SLOTS } from "./constants";
import { boxAt, judge, multiplierBps, normCdf, quoteBox, sigmaFromCandles, touchProbability } from "./odds";

const close = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

const market: Market = {
  authority: Keypair.generate().publicKey, oracle: Keypair.generate().publicKey, candles: Keypair.generate().publicKey,
  symbol: "SOL", band: 4_000_000n, colSecs: 4, sigmaFloor: 1_800_000n,
};
const book: Book = {
  authority: market.authority, mint: market.authority, liquidity: 10_000_000_000n, totalShares: 10_000_000_000n,
  exposure: 0n, edgeBps: 700, minMultBps: 11_000, maxMultBps: 250_000, maxExposureBps: 5_000,
  maxProfit: 500_000_000n, volume: 0n, taps: 0n,
};

function emptyCandles(): Candles {
  return { lastPrice: 0n, lastPublishTime: 0, ticks: 0n, secs: new BigInt64Array(CANDLE_SLOTS),
    highs: new BigInt64Array(CANDLE_SLOTS), lows: new BigInt64Array(CANDLE_SLOTS) };
}
function record(c: Candles, price: bigint, sec: number) {
  const i = sec % CANDLE_SLOTS;
  if (c.secs[i] !== BigInt(sec)) { c.secs[i] = BigInt(sec); c.highs[i] = price; c.lows[i] = price; }
  else { if (price > c.highs[i]!) c.highs[i] = price; if (price < c.lows[i]!) c.lows[i] = price; }
}

test("normal cdf and touch probability match the program", () => {
  close(normCdf(0), 0.5, 1e-7);
  close(normCdf(1), 0.84134475, 1e-6);
  close(touchProbability(0n, 200n, 300n, 4, 100), 0.3173105, 1e-6);
  assert.equal(touchProbability(100n, 90n, 110n, 4, 1), 1);
  assert.equal(multiplierBps(0.5, 700), 18_600);
  assert.equal(multiplierBps(0, 700), null);
});

test("quotes boxes like tap.rs", () => {
  const price = 8_998_000_000n, now = 1_000_001;
  const near = quoteBox(book, boxAt(market, 2251n, 250_002), price, now, 1_800_000);
  const far = quoteBox(book, boxAt(market, 2252n, 250_002), price, now, 1_800_000);
  assert.ok(near.ok && near.multBps >= 25_000 && near.multBps < 35_000);
  assert.ok(far.ok && far.multBps >= 90_000 && far.multBps < 110_000);
  assert.deepEqual(quoteBox(book, boxAt(market, 2249n, 250_002), price, now, 1_800_000), { ok: false, reason: "range" });
  assert.deepEqual(quoteBox(book, boxAt(market, 2251n, 250_000), price, now, 1_800_000), { ok: false, reason: "locked" });
  assert.deepEqual(quoteBox(book, boxAt(market, 2251n, 250_040), price, now, 1_800_000), { ok: false, reason: "too-far" });
});

test("judges like Candles::judge", () => {
  const c = emptyCandles();
  const walk: [bigint, bigint][] = [[1010n, 1000n], [1020n, 1005n], [1030n, 1015n], [1025n, 1012n], [1018n, 1010n]];
  walk.forEach(([h, l], i) => { record(c, h, 100 + i); record(c, l, 100 + i); });
  assert.equal(judge(c, 1028n, 1040n, 101, 104, 102), "win");
  assert.equal(judge(c, 1028n, 1040n, 101, 104, 101), "pending");
  assert.equal(judge(c, 1031n, 1040n, 101, 104, 104), "lose");
  assert.equal(judge(c, 1000n, 1100n, 150, 154, 160), "void");
});

test("estimates volatility like Candles::sigma", () => {
  const c = emptyCandles();
  assert.equal(sigmaFromCandles(c, 110), null);
  for (let s = 0; s < 12; s++) record(c, s % 2 === 0 ? 1000n : 1010n, 100 + s);
  close(sigmaFromCandles(c, 111)!, 10, 1e-9);
});
