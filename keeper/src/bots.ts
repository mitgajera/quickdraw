// One-time setup for the demo crowd: each bot wallet deposits its devnet USDC and moves its player
// account onto the rollup. Usage: BOT_KEYPAIRS=a.json,b.json pnpm --filter @quickdraw/keeper bots:setup
import { Connection } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID, ataOf, decodePlayer, ix, playerPda, sendWithKeypairs } from "@quickdraw/sdk";
import { botKeypairs, config } from "./config";

const base = new Connection(config.baseRpc, "confirmed");
const er = new Connection(config.erRpc, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const bot of botKeypairs()) {
  const who = bot.publicKey.toBase58();
  const pda = playerPda(bot.publicKey);
  const owner = (await base.getAccountInfo(pda))?.owner;
  const usdc = BigInt((await base.getTokenAccountBalance(ataOf(bot.publicKey)).catch(() => null))?.value.amount ?? "0");
  if (owner?.equals(DELEGATION_PROGRAM_ID)) {
    const p = await er.getAccountInfo(pda);
    console.log(`${who}: already on the rollup, game balance ${p ? Number(decodePlayer(p.data).balance) / 1e6 : "?"} USDC (wallet ${Number(usdc) / 1e6})`);
    continue;
  }
  const ixs = [];
  if (!owner) ixs.push(ix.initPlayer(bot.publicKey));
  if (usdc > 0n) ixs.push(ix.deposit(bot.publicKey, usdc));
  ixs.push(ix.delegatePlayer(bot.publicKey));
  const r = await sendWithKeypairs(base, ixs, [bot], { pollMs: 400 });
  for (let i = 0; i < 30 && !(await er.getAccountInfo(pda)); i++) await sleep(1000);
  console.log(`${who}: deposited ${Number(usdc) / 1e6} USDC and moved onto the rollup (${r.ms.toFixed(0)}ms)`);
}
process.exit(0);
