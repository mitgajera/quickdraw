// Devnet end-to-end check of wallet play: USDC stays in the wallet; a tap's stake is pulled on Solana by
// a Magic Action the program schedules from the rollup, and a win is paid straight back the same way.
// Usage: PLAYER_KEYPAIR=path pnpm --filter @quickdraw/keeper e2e:wallet
import { ComputeBudgetProgram, Connection, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID, PROGRAM_ID, WALLET_ALLOWANCE, actionEscrowPda, ataOf, bookPda, boxAt, createAtaIdempotent,
  decodeBook, decodeCandles, decodeLedger, decodeMarket, decodeOracle, decodePlayer, explainError, idealZoom, ix,
  ledgerPda, marketKeys, parseEvents, playerPda, quoteBox, rowHeight, sendSigned, sendWithKeypairs, sigmaFor,
} from "@quickdraw/sdk";
import { config, keeperKeypair, loadKeypair } from "./config";

const player = loadKeypair(process.env.PLAYER_KEYPAIR ?? "");
const keeper = keeperKeypair();
const base = new Connection(config.baseRpc, "confirmed");
const er = new Connection(config.erRpc, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const owner = player.publicKey;
const wallet = async () => BigInt((await base.getTokenAccountBalance(ataOf(owner)).catch(() => null))?.value.amount ?? "0");
const usd = (v: bigint) => (Number(v) / 1e6).toFixed(2);
const m = marketKeys("SOL");
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

// 0. the escrow that pays for Magic Actions on Solana
const escrowLamports = await base.getBalance(actionEscrowPda());
console.log(`action escrow ${actionEscrowPda().toBase58()}: ${escrowLamports / LAMPORTS_PER_SOL} SOL`);
if (escrowLamports < 0.1 * LAMPORTS_PER_SOL) {
  await sendWithKeypairs(base, [ix.topUpActionEscrow(keeper.publicKey, BigInt(0.3 * LAMPORTS_PER_SOL))], [keeper], { pollMs: 400 });
  console.log(`topped up -> ${(await base.getBalance(actionEscrowPda())) / LAMPORTS_PER_SOL} SOL`);
}

// 1. any old game balance goes back to the wallet first
const baseOwner = async () => (await base.getAccountInfo(playerPda(owner)))?.owner;
const onEr = await er.getAccountInfo(playerPda(owner));
if (onEr && (await baseOwner())?.equals(DELEGATION_PROGRAM_ID) && decodePlayer(onEr.data).balance > 0n) {
  await sendWithKeypairs(er, [ix.undelegatePlayer(owner)], [player]);
  for (let i = 0; i < 80 && !(await baseOwner())?.equals(PROGRAM_ID); i++) await sleep(750);
  const bal = decodePlayer((await base.getAccountInfo(playerPda(owner)))!.data).balance;
  await sendWithKeypairs(base, [ix.withdraw(owner, bal)], [player], { pollMs: 400 });
  console.log(`moved old game balance ${usd(bal)} USDC back to the wallet`);
}

// 2. one base transaction: ledger + allowance (+ player account, + delegation)
const setup = [createAtaIdempotent(owner, owner)];
if (!(await base.getAccountInfo(playerPda(owner)))) setup.push(ix.initPlayer(owner));
if (!(await base.getAccountInfo(ledgerPda(owner)))) setup.push(ix.initLedger(owner));
setup.push(ix.approveVault(owner, WALLET_ALLOWANCE));
if (!(await baseOwner())?.equals(DELEGATION_PROGRAM_ID)) setup.push(ix.delegatePlayer(owner));
await sendWithKeypairs(base, setup, [player], { pollMs: 400 });
for (let i = 0; i < 40 && !(await er.getAccountInfo(playerPda(owner))); i++) await sleep(750);
const before = await wallet();
console.log(`${at()} wallet ${usd(before)} USDC, allowance approved, player on the rollup`);

// 3. tap the box holding the price (the likeliest win), straight from the wallet
const [mi, bi, ci, oi] = await er.getMultipleAccountsInfo([m.market, bookPda(), m.candles, m.oracle]);
const market = decodeMarket(mi!.data), book = decodeBook(bi!.data), candles = decodeCandles(ci!.data), o = decodeOracle(oi!.data);
const sigma = sigmaFor(market, candles, o.publishTime);
const zoom = idealZoom(market, book, o.price, o.publishTime, sigma);
const row = o.price / rowHeight(market, zoom), column = Math.floor(o.publishTime / market.colSecs) + 2;
const stake = 1_000_000n;
const q = quoteBox(book, boxAt(market, row, column, zoom), o.price, o.publishTime, sigma, stake);
if (!q.ok) throw new Error(`box not offered: ${q.reason}`);
const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix.placeWalletTap({
  signer: owner, owner, market: m, bandIndex: row, column, zoom, stake, minMultBps: Math.floor(q.multBps * 0.85),
}));
tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
tx.feePayer = owner;
tx.sign(player);
try {
  const r = await sendSigned(er, tx, { pollMs: 15, withLogs: true });
  console.log(`${at()} wallet tap at ${(q.multBps / 1e4).toFixed(2)}x confirmed on the rollup in ${r.ms.toFixed(0)}ms (${r.signature})`);
} catch (e) {
  console.log("tap failed:", explainError(e));
  const sim = await er.simulateTransaction(tx).catch(() => null);
  console.log(sim?.value.logs?.slice(-25).join("\n"));
  process.exit(1);
}

// 4. the Magic Action pulls the stake from the wallet on Solana
for (let i = 0; i < 60; i++) {
  const w = await wallet();
  const led = await base.getAccountInfo(ledgerPda(owner));
  if (w < before) {
    console.log(`${at()} stake collected on Solana: wallet ${usd(before)} -> ${usd(w)}, ledger collected ${usd(decodeLedger(led!.data).collectedTotal)}`);
    break;
  }
  if (i === 59) console.log("stake was NOT collected within 60s");
  await sleep(1000);
}

// 5. settle on the rollup (the keeper will do this; here the player cranks it)
let outcome = "";
for (let i = 0; i < 90 && !outcome; i++) {
  await sleep(1000);
  try {
    const st = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix.settleWallet(owner, owner, m));
    st.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
    st.feePayer = owner;
    st.sign(player);
    const r = await sendSigned(er, st, { pollMs: 30, withLogs: true });
    for (const ev of parseEvents(r.logs)) if (ev.kind === "TapSettled") outcome = `${ev.outcome}, paid ${usd(ev.payout)} USDC`;
    outcome ||= "settled";
  } catch (e) {
    const msg = explainError(e);
    if (!/settled yet/i.test(msg)) console.log("settle:", msg);
  }
}
console.log(`${at()} settled on the rollup: ${outcome}`);

// 6. a win's payout lands straight in the wallet
const afterTap = await wallet();
for (let i = 0; i < 60; i++) {
  const w = await wallet();
  if (w > afterTap || !outcome.startsWith("win")) {
    const led = decodeLedger((await base.getAccountInfo(ledgerPda(owner)))!.data);
    console.log(`${at()} wallet now ${usd(w)} USDC (started ${usd(before)}), ledger paid ${usd(led.paidTotal)}`);
    break;
  }
  await sleep(1000);
}
process.exit(0);
