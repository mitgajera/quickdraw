// Adds the house wallet's devnet USDC to the book as liquidity: take the house's player account off the
// rollup, deposit the wallet's USDC, hand the account back, then lp_add it on the rollup.
// Usage: HOUSE_KEYPAIR=path pnpm --filter @quickdraw/keeper topup
import { Connection } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID, PROGRAM_ID, ataOf, bookPda, decodeBook, ix, playerPda, sendWithKeypairs,
} from "@quickdraw/sdk";
import { config, loadKeypair } from "./config";

const house = loadKeypair(config.houseKeypairPath);
const base = new Connection(config.baseRpc, "confirmed");
const er = new Connection(config.erRpc, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const player = playerPda(house.publicKey);
const owner = async () => (await base.getAccountInfo(player))?.owner;
const liquidity = async () => Number(decodeBook((await er.getAccountInfo(bookPda()))!.data).liquidity) / 1e6;

const amount = BigInt((await base.getTokenAccountBalance(ataOf(house.publicKey)).catch(() => null))?.value.amount ?? "0");
console.log(`house ${house.publicKey.toBase58()}: wallet ${Number(amount) / 1e6} USDC, book liquidity ${await liquidity()} USDC`);
if (amount === 0n) process.exit(0);

if ((await owner())?.equals(DELEGATION_PROGRAM_ID)) {
  const r = await sendWithKeypairs(er, [ix.undelegatePlayer(house.publicKey)], [house]);
  console.log(`undelegate house player   ${r.ms.toFixed(0)}ms`);
  for (let i = 0; i < 60 && !(await owner())?.equals(PROGRAM_ID); i++) await sleep(1000);
  if (!(await owner())?.equals(PROGRAM_ID)) throw new Error("house player did not come back to the base layer");
}

const d = await sendWithKeypairs(base, [ix.deposit(house.publicKey, amount), ix.delegatePlayer(house.publicKey)], [house], { pollMs: 400 });
console.log(`deposit ${Number(amount) / 1e6} USDC + delegate   ${d.ms.toFixed(0)}ms`);
for (let i = 0; i < 30 && !(await er.getAccountInfo(player)); i++) await sleep(1000);
await sleep(2000); // let the ER pick up the fresh balance

const l = await sendWithKeypairs(er, [ix.lpAdd(house.publicKey, amount)], [house]);
console.log(`lp_add ${Number(amount) / 1e6} USDC   ${l.ms.toFixed(0)}ms`);
console.log(`book liquidity now ${await liquidity()} USDC`);
process.exit(0);
