// End-to-end check of golden columns on devnet: MagicBlock VRF draws the round on the ER, a wallet tap
// in the golden column is flagged golden, and a 2x+ win there pays USDC and mints a Golden Tap.
// Needs a wallet already set up for wallet play (e.g. a house player) and a keeper settling taps.
// Usage: PLAYER_KEYPAIR=path/to/wallet.json pnpm --filter @quickdraw/keeper exec tsx src/golden-e2e.ts
import { ComputeBudgetProgram, Connection, Transaction } from "@solana/web3.js";
import {
  GOLDEN_MINT, GOLDEN_MIN_MULT_BPS, GOLDEN_TAP_FLAG, ROUND_SECS, ataOf, bookPda, boxAt, createAtaIdempotent,
  decodeBook, decodeCandles, decodeLucky, decodeMarket, decodeOracle, decodePlayer, explainError, goldenColumnStart,
  idealZoom, ix, luckyPda, luckySeed, marketKeys, playerPda, quoteBox, rowHeight, sendSigned, sendWithKeypairs, sigmaFor,
} from "@quickdraw/sdk";
import { config, loadKeypair } from "./config";

const base = new Connection(config.baseRpc, "confirmed");
const er = new Connection(config.erRpc, "confirmed");
const player = loadKeypair(process.env.PLAYER_KEYPAIR ?? config.keypairPath);
const owner = player.publicKey;
const m = marketKeys("SOL");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = () => new Date().toISOString().slice(11, 19);
const goldenBalance = async () =>
  base.getTokenAccountBalance(ataOf(owner, GOLDEN_MINT)).then((r) => Number(r.value.amount)).catch(() => -1);

// 1. a Golden Tap account to receive the collectible
if ((await goldenBalance()) < 0) {
  await sendWithKeypairs(base, [createAtaIdempotent(owner, owner, GOLDEN_MINT)], [player], { pollMs: 500 });
  console.log(`${at()} opened the Golden Tap account ${ataOf(owner, GOLDEN_MINT).toBase58()}`);
}
const startGolden = await goldenBalance();

for (let attempt = 1; attempt <= 6; attempt++) {
  // 2. the round must be drawn (the keeper requests it; ask ourselves too, it is free and permissionless)
  const round = Math.floor(Date.now() / 1000 / ROUND_SECS);
  let lucky = decodeLucky((await er.getAccountInfo(luckyPda()))!.data);
  if (!luckySeed(lucky, round + 1)) {
    await sendWithKeypairs(er, [ix.requestLucky(owner, round + 1)], [player], { skipPreflight: true }).catch(() => {});
  }
  for (let i = 0; i < 20 && !luckySeed(lucky, round); i++) {
    if (i === 0) await sendWithKeypairs(er, [ix.requestLucky(owner, round)], [player], { skipPreflight: true }).catch(() => {});
    await sleep(500);
    lucky = decodeLucky((await er.getAccountInfo(luckyPda()))!.data);
  }
  if (!luckySeed(lucky, round)) throw new Error(`round ${round} was never drawn: is the VRF callback reaching the ER?`);
  console.log(`${at()} round ${round} drawn by VRF`);

  // 3. the golden column must be 2-4 columns ahead to be tappable
  const [mi, bi, ci, oi] = await er.getMultipleAccountsInfo([m.market, bookPda(), m.candles, m.oracle]);
  const market = decodeMarket(mi!.data), book = decodeBook(bi!.data), candles = decodeCandles(ci!.data), o = decodeOracle(oi!.data);
  const colNow = Math.floor(o.publishTime / market.colSecs);
  let target: number | null = null;
  for (const c of [colNow + 2, colNow + 3, colNow + 4]) {
    const g = goldenColumnStart(lucky, m.market, market.colSecs, c * market.colSecs);
    if (g === c * market.colSecs) target = c;
  }
  if (target === null) {
    console.log(`${at()} golden column not in reach yet, waiting`);
    await sleep(3000);
    attempt--;
    continue;
  }
  const sigma = sigmaFor(market, candles, o.publishTime);
  const zoom = idealZoom(market, book, o.price, o.publishTime, sigma);
  const row = o.price / rowHeight(market, zoom);
  const stake = 100_000n;
  let pick: { band: bigint; mult: number } | null = null;
  for (const d of [1n, -1n, 2n, -2n, 3n, -3n]) {
    const q = quoteBox(book, boxAt(market, row + d, target, zoom), o.price, o.publishTime, sigma, stake);
    if (q.ok && q.multBps >= GOLDEN_MIN_MULT_BPS) { pick = { band: row + d, mult: q.multBps }; break; }
  }
  if (!pick) { console.log(`${at()} no 2x+ box in the golden column, next round`); await sleep(5000); continue; }

  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix.placeWalletTap({
    signer: owner, owner, market: m, bandIndex: pick.band, column: target, zoom, stake,
    minMultBps: Math.floor(pick.mult * 0.85), quotedMultBps: pick.mult,
  }));
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  tx.feePayer = owner;
  tx.sign(player);
  try {
    const r = await sendSigned(er, tx, { pollMs: 15 });
    console.log(`${at()} golden-column tap at ${(pick.mult / 1e4).toFixed(1)}x confirmed in ${r.ms.toFixed(0)}ms`);
  } catch (e) {
    console.log(`${at()} tap failed: ${explainError(e)}`);
    await sleep(4000);
    continue;
  }
  const p = decodePlayer((await er.getAccountInfo(playerPda(owner)))!.data);
  const tap = p.taps.find((t) => t.open && t.start === target! * market.colSecs);
  console.log(`${at()} tap flagged golden: ${!!tap && (tap.id & GOLDEN_TAP_FLAG) !== 0}`);

  // 4. settlement (keeper) and, on a win, the Golden Tap
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const now = decodePlayer((await er.getAccountInfo(playerPda(owner)))!.data);
    const still = now.taps.find((t) => t.open && t.id === tap?.id);
    if (still) continue;
    const won = now.wins > p.wins;
    console.log(`${at()} settled: ${won ? "WIN" : "loss"}`);
    if (!won) break;
    for (let j = 0; j < 30; j++) {
      const g = await goldenBalance();
      if (g > startGolden) { console.log(`${at()} Golden Tap minted to the wallet: ${startGolden} -> ${g}`); process.exit(0); }
      await sleep(1000);
    }
    throw new Error("won in the golden column, but no Golden Tap arrived");
  }
  console.log(`${at()} trying another round`);
}
console.log("no golden win in 6 attempts (that is luck, not a bug); rerun");
process.exit(0);
