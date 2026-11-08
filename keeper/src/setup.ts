// One-time, idempotent devnet setup: house book (devnet USDC), markets, delegation to the ER, and
// the house's USDC bankroll as liquidity. Run as the house: `HOUSE_KEYPAIR=… pnpm --filter
// @quickdraw/keeper bootstrap`.
import { Buffer } from "node:buffer";
import { Connection, type PublicKey } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID, ER_VALIDATOR, USD, USDC_MINT, ataOf, bookPda, buildIx, decodeBook, decodeMarket, ix, marketKeys, playerPda,
  sendWithKeypairs, type Symbol,
} from "@quickdraw/sdk";
import { config, loadKeypair } from "./config";

const me = loadKeypair(config.houseKeypairPath);
const base = new Connection(config.baseRpc, "confirmed");
const er = new Connection(config.erRpc, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Grid per market: row height and volatility floor in 1e-8 USD, 4-second columns. Rows are sized
 * from recorded oracle data so a typical 4-second move crosses about one row (the chart moves),
 * and floors sit near the calm-market volatility.
 */
const GRIDS: Record<Symbol, { band: bigint; sigmaFloor: bigint }> = {
  // base rows ~0.7x each market's realised per-second volatility; the app zooms out (up to 16x)
  // when a market is busy, so calm markets still move and busy ones keep a gradient of odds
  SOL: { band: 375_000n, sigmaFloor: 75_000n },           // $0.00375 base rows, $0.00075/sqrt(s)
  BTC: { band: 250_000_000n, sigmaFloor: 20_000_000n },   // $2.50 base rows, $0.20/sqrt(s)
  ETH: { band: 7_500_000n, sigmaFloor: 600_000n },        // $0.075 base rows, $0.006/sqrt(s)
};
const COL_SECS = 4;

const owner = async (c: Connection, k: PublicKey) => (await c.getAccountInfo(k))?.owner;
async function run(label: string, c: Connection, ixs: Parameters<typeof sendWithKeypairs>[1]) {
  const r = await sendWithKeypairs(c, ixs, [me], { pollMs: c === base ? 400 : 20 });
  console.log(`${label.padEnd(24)} ${r.ms.toFixed(0).padStart(5)}ms ${r.signature}`);
}
const known = { authority: me.publicKey, payer: me.publicKey };

console.log(`authority ${me.publicKey.toBase58()}`);

const book = bookPda();
if (!(await owner(base, book))) {
  await run("init_book", base, [buildIx("init_book", known, {
    params: { edge_bps: 1000, min_mult_bps: 11_000, max_mult_bps: 500_000, max_exposure_bps: 5_000, max_profit: 50n * USD },
  })]);
}

for (const symbol of config.markets) {
  const m = marketKeys(symbol);
  const grid = GRIDS[symbol];
  const params = { symbol: [...Buffer.from(symbol.padEnd(8, "\0"))], band: grid.band, col_secs: COL_SECS, sigma_floor: grid.sigmaFloor };
  const existing = await base.getAccountInfo(m.market);
  if (!existing) {
    await run(`init_market ${symbol}`, base, [buildIx("init_market", { ...known, oracle: m.oracle }, { params })]);
  } else {
    // reconcile: markets are not delegated, so the ER picks up base-layer updates within ~1s
    const cur = decodeMarket(existing.data);
    if (cur.band !== grid.band || cur.sigmaFloor !== grid.sigmaFloor || cur.colSecs !== COL_SECS) {
      await run(`update_market ${symbol}`, base, [buildIx("update_market", { ...known, market: m.market }, { params })]);
    }
  }
  if (!(await owner(base, m.candles))?.equals(DELEGATION_PROGRAM_ID)) {
    await run(`delegate candles ${symbol}`, base, [buildIx("delegate_candles", { ...known, market: m.market, "market.oracle": m.oracle }, {}, [ER_VALIDATOR])]);
  }
}

if (!(await owner(base, book))?.equals(DELEGATION_PROGRAM_ID)) {
  await run("delegate book", base, [buildIx("delegate_book", known, {}, [ER_VALIDATOR])]);
}

// seed the house: the house wallet's devnet USDC becomes book liquidity through its own player account
const player = playerPda(me.publicKey);
for (let i = 0; i < 30 && !(await er.getAccountInfo(book)); i++) await sleep(1000);
const b = decodeBook((await er.getAccountInfo(book))!.data);
if (b.totalShares === 0n) {
  const usdc = BigInt((await base.getTokenAccountBalance(ataOf(me.publicKey, USDC_MINT)).catch(() => null))?.value.amount ?? "0");
  if (usdc === 0n) throw new Error(`house ${me.publicKey.toBase58()} holds no devnet USDC to seed the book`);
  if (!(await owner(base, player))) {
    await run(`player + deposit ${Number(usdc) / 1e6} USDC`, base, [ix.initPlayer(me.publicKey), ix.deposit(me.publicKey, usdc)]);
  }
  if (!(await owner(base, player))?.equals(DELEGATION_PROGRAM_ID)) await run("delegate player", base, [ix.delegatePlayer(me.publicKey)]);
  for (let i = 0; i < 30 && !(await er.getAccountInfo(player)); i++) await sleep(1000);
  await run(`lp_add ${Number(usdc) / 1e6} USDC`, er, [ix.lpAdd(me.publicKey, usdc)]);
}

const after = decodeBook((await er.getAccountInfo(book))!.data);
console.log(`book ${bookPda().toBase58()} liquidity ${Number(after.liquidity) / 1e6} USDC, exposure ${Number(after.exposure) / 1e6}, taps ${after.taps}`);
