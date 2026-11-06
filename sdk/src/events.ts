import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import { IDL } from "./instructions";

export interface TapPlaced {
  kind: "TapPlaced"; player: PublicKey; market: PublicKey; id: number; slot: number;
  lo: bigint; hi: bigint; start: number; end: number; stake: bigint; multBps: number;
  price: bigint; publishTime: number; sigma: bigint;
}

export interface TapSettled {
  kind: "TapSettled"; player: PublicKey; market: PublicKey; id: number;
  outcome: "win" | "lose" | "void"; lo: bigint; hi: bigint; start: number; end: number;
  stake: bigint; payout: bigint; low: bigint; high: bigint;
}

export type QuickdrawEvent = TapPlaced | TapSettled;

const disc = (name: string) => Buffer.from(IDL.events?.find((e) => e.name === name)?.discriminator ?? []);
const PLACED = disc("TapPlaced");
const SETTLED = disc("TapSettled");

/** Decodes Quickdraw events from a transaction's `Program data:` log lines. */
export function parseEvents(logs: readonly string[]): QuickdrawEvent[] {
  const out: QuickdrawEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const b = Buffer.from(line.slice(14), "base64");
    let o = 8;
    const pk = () => { const v = new PublicKey(b.subarray(o, o + 32)); o += 32; return v; };
    const u8 = () => b.readUInt8(o++);
    const u32 = () => { const v = b.readUInt32LE(o); o += 4; return v; };
    const u64 = () => { const v = b.readBigUInt64LE(o); o += 8; return v; };
    const i64 = () => { const v = b.readBigInt64LE(o); o += 8; return v; };
    const head = b.subarray(0, 8);
    if (head.equals(PLACED)) {
      out.push({
        kind: "TapPlaced", player: pk(), market: pk(), id: u32(), slot: u8(), lo: i64(), hi: i64(),
        start: Number(i64()), end: Number(i64()), stake: u64(), multBps: u32(), price: i64(),
        publishTime: Number(i64()), sigma: u64(),
      });
    } else if (head.equals(SETTLED)) {
      const player = pk(), market = pk(), id = u32(), code = u8();
      out.push({
        kind: "TapSettled", player, market, id, outcome: code === 1 ? "win" : code === 2 ? "lose" : "void",
        lo: i64(), hi: i64(), start: Number(i64()), end: Number(i64()), stake: u64(), payout: u64(),
        low: i64(), high: i64(),
      });
    }
  }
  return out;
}
