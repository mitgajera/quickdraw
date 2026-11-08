// One-time setup for the house players: gets each wallet ready for wallet play (a ledger, the vault's
// spending approval, the player account on the rollup), like any player's first sign-in.
// Usage: BOT_KEYPAIRS=a.json,b.json pnpm --filter @quickdraw/keeper bots:setup
import { Connection, type TransactionInstruction } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID, WALLET_ALLOWANCE, ataOf, createAtaIdempotent, ix, ledgerPda, playerPda, sendWithKeypairs,
} from "@quickdraw/sdk";
import { botKeypairs, config } from "./config";

const base = new Connection(config.baseRpc, "confirmed");
const er = new Connection(config.erRpc, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const bot of botKeypairs()) {
  const who = bot.publicKey.toBase58();
  const owner = bot.publicKey;
  const [player, ledger, ata] = await base.getMultipleAccountsInfo([playerPda(owner), ledgerPda(owner), ataOf(owner)]);
  const ixs: TransactionInstruction[] = [];
  if (!ata) ixs.push(createAtaIdempotent(owner, owner));
  if (!player) ixs.push(ix.initPlayer(owner));
  if (!ledger) ixs.push(ix.initLedger(owner));
  ixs.push(ix.approveVault(owner, WALLET_ALLOWANCE));
  if (!player?.owner.equals(DELEGATION_PROGRAM_ID)) ixs.push(ix.delegatePlayer(owner));
  const r = await sendWithKeypairs(base, ixs, [bot], { pollMs: 400 });
  for (let i = 0; i < 30 && !(await er.getAccountInfo(playerPda(owner))); i++) await sleep(1000);
  console.log(`${who}: ready for wallet play (${r.ms.toFixed(0)}ms)`);
  await sleep(500);
}
process.exit(0);
