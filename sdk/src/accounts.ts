import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import { CANDLE_SLOTS, MAX_TAPS, ONE_X_BPS } from "./constants";

/** Sequential little-endian reader that skips the 8-byte Anchor discriminator. */
class Reader {
  private o = 8;
  constructor(private readonly b: Buffer) {}
  pk() { const v = new PublicKey(this.b.subarray(this.o, this.o + 32)); this.o += 32; return v; }
  bytes(n: number) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  u8() { return this.b.readUInt8(this.o++); }
  bool() { return this.u8() === 1; }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  i64() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return v; }
}

const buf = (data: Uint8Array) => Buffer.from(data.buffer, data.byteOffset, data.byteLength);

export interface Book {
  authority: PublicKey; mint: PublicKey;
  liquidity: bigint; totalShares: bigint; exposure: bigint;
  edgeBps: number; minMultBps: number; maxMultBps: number; maxExposureBps: number;
  maxProfit: bigint; volume: bigint; taps: bigint;
}

export function decodeBook(data: Uint8Array): Book {
  const r = new Reader(buf(data));
  return {
    authority: r.pk(), mint: r.pk(), liquidity: r.u64(), totalShares: r.u64(), exposure: r.u64(),
    edgeBps: r.u16(), minMultBps: r.u32(), maxMultBps: r.u32(), maxExposureBps: r.u16(),
    maxProfit: r.u64(), volume: r.u64(), taps: r.u64(),
  };
}

export interface Market {
  authority: PublicKey; oracle: PublicKey; candles: PublicKey;
  symbol: string; band: bigint; colSecs: number; sigmaFloor: bigint;
}

export function decodeMarket(data: Uint8Array): Market {
  const r = new Reader(buf(data));
  return {
    authority: r.pk(), oracle: r.pk(), candles: r.pk(),
    symbol: Buffer.from(r.bytes(8)).toString("utf8").replace(/\0+$/, ""),
    band: r.u64(), colSecs: r.u32(), sigmaFloor: r.u64(),
  };
}

export interface TapSlot {
  slot: number; market: PublicKey; lo: bigint; hi: bigint; start: number; end: number;
  stake: bigint; multBps: number; id: number; open: boolean;
}

export const payoutOf = (t: Pick<TapSlot, "stake" | "multBps">) =>
  (t.stake * BigInt(t.multBps)) / BigInt(ONE_X_BPS);

export interface Player {
  owner: PublicKey; session: PublicKey; sessionExpires: number;
  balance: bigint; shares: bigint; nextId: number; tapsPlaced: number; wins: number;
  streak: number; bestStreak: number; pnl: bigint; taps: TapSlot[];
}

export function decodePlayer(data: Uint8Array): Player {
  const r = new Reader(buf(data));
  const p = {
    owner: r.pk(), session: r.pk(), sessionExpires: Number(r.i64()), balance: r.u64(), shares: r.u64(),
    nextId: r.u32(), tapsPlaced: r.u32(), wins: r.u32(), streak: r.u16(), bestStreak: r.u16(), pnl: r.i64(),
    taps: [] as TapSlot[],
  };
  for (let slot = 0; slot < MAX_TAPS; slot++) {
    p.taps.push({
      slot, market: r.pk(), lo: r.i64(), hi: r.i64(), start: Number(r.i64()), end: Number(r.i64()),
      stake: r.u64(), multBps: r.u32(), id: r.u32(), open: r.bool(),
    });
  }
  return p;
}

/** Per-second high/low ring written by `record_tick` (zero-copy, so plain arrays). */
export interface Candles {
  lastPrice: bigint; lastPublishTime: number; ticks: bigint;
  secs: BigInt64Array; highs: BigInt64Array; lows: BigInt64Array;
}

export function decodeCandles(data: Uint8Array): Candles {
  const b = buf(data);
  const base = 8 + 32;
  const arr = (offset: number) => {
    const out = new BigInt64Array(CANDLE_SLOTS);
    for (let i = 0; i < CANDLE_SLOTS; i++) out[i] = b.readBigInt64LE(offset + i * 8);
    return out;
  };
  const secsAt = base + 24;
  return {
    lastPrice: b.readBigInt64LE(base),
    lastPublishTime: Number(b.readBigInt64LE(base + 8)),
    ticks: b.readBigUInt64LE(base + 16),
    secs: arr(secsAt),
    highs: arr(secsAt + CANDLE_SLOTS * 8),
    lows: arr(secsAt + CANDLE_SLOTS * 16),
  };
}

/** MagicBlock oracle price account (as seen on the ER): price @73, publish time @93. */
export interface OraclePrice { price: bigint; publishTime: number }

export function decodeOracle(data: Uint8Array): OraclePrice {
  const b = buf(data);
  return { price: b.readBigInt64LE(73), publishTime: Number(b.readBigInt64LE(93)) };
}

/** Wallet play: which wallet-tap stakes the house has collected (base layer). */
export interface Ledger { owner: PublicKey; collected: number[]; head: number; collectedTotal: bigint; paidTotal: bigint }

export function decodeLedger(data: Uint8Array): Ledger {
  const r = new Reader(buf(data));
  const owner = r.pk();
  const collected: number[] = [];
  for (let i = 0; i < 32; i++) collected.push(r.u32());
  return { owner, collected, head: r.u8(), collectedTotal: r.u64(), paidTotal: r.u64() };
}
