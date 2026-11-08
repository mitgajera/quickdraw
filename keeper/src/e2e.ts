// Devnet end-to-end check with a real devnet-USDC wallet: deposit everything, open a session, tap two
// boxes the program prices, wait for the keeper to settle them, then cash out back to the wallet.
// Usage: PLAYER_KEYPAIR=path pnpm --filter @quickdraw/keeper e2e
import { Connection, Keypair, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID, PROGRAM_ID, ataOf, boxAt, decodeBook, decodeCandles, decodeMarket, decodeOracle, decodePlayer,
  bookPda, idealZoom, ix, marketKeys, playerPda, quoteBox, rowHeight, sendSigned, sendWithKeypairs, sigmaFor,
} from "@quickdraw/sdk";
import { config, loadKeypair } from "./config";

const player = loadKeypair(process.env.PLAYER_KEYPAIR ?? "");
const base = new Connection(config.baseRpc, "confirmed");
const er = new Connection(config.erRpc, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usdc = async () => Number((await base.getTokenAccountBalance(ataOf(player.publicKey)).catch(() => null))?.value.amount ?? 0) / 1e6;
const owner = async () => (await base.getAccountInfo(playerPda(player.publicKey)))?.owner;
const m = marketKeys("SOL");

console.log(`player ${player.publicKey.toBase58()}  wallet USDC ${await usdc()}`);

// 1. deposit + session + delegate in one base-layer transaction
const session = Keypair.generate();
if (!(await owner())?.equals(DELEGATION_PROGRAM_ID)) {
  const amount = BigInt(Math.round((await usdc()) * 1e6));
  const ixs = [];
  if (!(await owner())) ixs.push(ix.initPlayer(player.publicKey));
  if (amount > 0n) ixs.push(ix.deposit(player.publicKey, amount));
  ixs.push(ix.setSession(player.publicKey, session.publicKey, Math.floor(Date.now() / 1000) + 3600), ix.delegatePlayer(player.publicKey));
  const r = await sendWithKeypairs(base, ixs, [player], { pollMs: 400 });
  console.log(`deposit + session + delegate  ${r.ms.toFixed(0)}ms`);
} else {
  await sendWithKeypairs(er, [ix.setSession(player.publicKey, session.publicKey, Math.floor(Date.now() / 1000) + 3600)], [player]);
}
for (let i = 0; i < 30 && !(await er.getAccountInfo(playerPda(player.publicKey))); i++) await sleep(1000);
const balanceOf = async () => decodePlayer((await er.getAccountInfo(playerPda(player.publicKey)))!.data).balance;
console.log(`game balance ${Number(await balanceOf()) / 1e6} USDC, wallet ${await usdc()}`);

// 2. tap two boxes the program will accept, priced like the app does
const [mi, bi, ci, oi] = await er.getMultipleAccountsInfo([m.market, bookPda(), m.candles, m.oracle]);
const market = decodeMarket(mi!.data), book = decodeBook(bi!.data), candles = decodeCandles(ci!.data), o = decodeOracle(oi!.data);
const sigma = sigmaFor(market, candles, o.publishTime);
const zoom = idealZoom(market, book, o.price, o.publishTime, sigma);
const row = o.price / rowHeight(market, zoom), column = Math.floor(o.publishTime / market.colSecs) + 2;
for (const dRow of [1n, -1n]) {
  const q = quoteBox(book, boxAt(market, row + dRow, column, zoom), o.price, o.publishTime, sigma);
  if (!q.ok) { console.log(`row ${dRow}: not offered (${q.reason})`); continue; }
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), ix.placeTap({
    signer: session.publicKey, owner: player.publicKey, market: m, bandIndex: row + dRow, column, zoom,
    stake: 1_000_000n, minMultBps: Math.floor(q.multBps * 0.85),
  }));
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  tx.feePayer = session.publicKey;
  tx.sign(session);
  const r = await sendSigned(er, tx, { skipPreflight: true, pollMs: 15 });
  console.log(`tap row ${dRow > 0 ? "+" : ""}${dRow} zoom ${zoom} at ${(q.multBps / 1e4).toFixed(2)}x: ${r.ms.toFixed(0)}ms`);
}

// 3. wait for the keeper to settle
for (let i = 0; i < 60; i++) {
  const p = decodePlayer((await er.getAccountInfo(playerPda(player.publicKey)))!.data);
  if (!p.taps.some((t) => t.open)) { console.log(`settled: wins ${p.wins}, pnl ${Number(p.pnl) / 1e6} USDC, balance ${Number(p.balance) / 1e6}`); break; }
  await sleep(1000);
}

// 4. cash out: undelegate on the ER, then withdraw the whole balance on Solana
await sendWithKeypairs(er, [ix.undelegatePlayer(player.publicKey)], [player]);
for (let i = 0; i < 60 && !(await owner())?.equals(PROGRAM_ID); i++) await sleep(1000);
const final = decodePlayer((await base.getAccountInfo(playerPda(player.publicKey)))!.data).balance;
if (final > 0n) await sendWithKeypairs(base, [ix.withdraw(player.publicKey, final)], [player], { pollMs: 400 });
console.log(`cashed out ${Number(final) / 1e6} USDC -> wallet now ${await usdc()} USDC`);
process.exit(0);
