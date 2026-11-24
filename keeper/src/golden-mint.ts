// One-time setup for the Golden Tap collectible: an SPL token with 0 decimals (each token is one
// collectible). The house creates it and keeps mint authority until its metadata (name, image) is
// added; `golden-handoff` then hands minting to the program's `golden-auth` PDA, after which only a
// golden win can mint one.
// Usage: HOUSE_KEYPAIR=path/to/house.json GOLDEN_MINT_KEYPAIR=path/to/golden-mint.json \
//          pnpm --filter @quickdraw/keeper exec tsx src/golden-mint.ts [lucky | handoff | metadata [uri]]
// `lucky` creates the golden-column draw account and moves it to the ephemeral rollup.
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import fs from "node:fs";
import { DELEGATION_PROGRAM_ID, PROGRAM_ID, ix, luckyPda, sendWithKeypairs } from "@quickdraw/sdk";
import { config, loadKeypair } from "./config";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MINT_SIZE = 82;
const base = new Connection(config.baseRpc, "confirmed");
const house = loadKeypair(config.houseKeypairPath);
const mintPath = process.env.GOLDEN_MINT_KEYPAIR;
if (!mintPath) throw new Error("set GOLDEN_MINT_KEYPAIR (a keypair file for the mint address)");
if (!fs.existsSync(mintPath)) fs.writeFileSync(mintPath, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
const mint = loadKeypair(mintPath);
const goldenAuth = PublicKey.findProgramAddressSync([Buffer.from("golden-auth")], PROGRAM_ID)[0];

if (process.argv[2] === "lucky") {
  // the golden-column draw account: create it on Solana (house as authority), then move it to the ER
  const lucky = luckyPda();
  if (!(await base.getAccountInfo(lucky))) {
    await sendWithKeypairs(base, [ix.initLucky(house.publicKey)], [house]);
    console.log(`lucky account created: ${lucky.toBase58()}`);
  }
  if (!(await base.getAccountInfo(lucky))?.owner.equals(DELEGATION_PROGRAM_ID)) {
    await sendWithKeypairs(base, [ix.delegateLucky(house.publicKey)], [house]);
    console.log("lucky account delegated to the ephemeral rollup");
  } else {
    console.log("lucky account already on the ephemeral rollup");
  }
  process.exit(0);
}

if (process.argv[2] === "metadata") {
  // name and image for wallets; the JSON and PNG are served by the app (app/public/golden-tap.*)
  const uri = process.argv[3] ?? "https://quickdraw-beta.vercel.app/golden-tap.json";
  await sendWithKeypairs(base, [ix.goldenMetadata(house.publicKey, "Golden Tap", "GTAP", uri)], [house]);
  console.log(`Golden Tap metadata created, uri ${uri}`);
  process.exit(0);
}

if (process.argv[2] === "handoff") {
  // SetAuthority(MintTokens) -> the program's golden-auth PDA
  const data = Buffer.concat([Buffer.from([6, 0, 1]), goldenAuth.toBuffer()]);
  await sendWithKeypairs(base, [new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID, data,
    keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }, { pubkey: house.publicKey, isSigner: true, isWritable: false }],
  })], [house]);
  console.log(`mint authority of ${mint.publicKey.toBase58()} is now the program's golden-auth PDA ${goldenAuth.toBase58()}`);
  process.exit(0);
}

if (await base.getAccountInfo(mint.publicKey)) {
  console.log(`golden mint already exists: ${mint.publicKey.toBase58()}`);
  process.exit(0);
}
const rent = await base.getMinimumBalanceForRentExemption(MINT_SIZE);
// InitializeMint2: decimals 0, mint authority = house (for now), no freeze authority
const init = Buffer.concat([Buffer.from([20, 0]), house.publicKey.toBuffer(), Buffer.from([0])]);
await sendWithKeypairs(base, [
  SystemProgram.createAccount({ fromPubkey: house.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
  new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, data: init, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }] }),
], [house, mint]);
console.log(`golden mint created: ${mint.publicKey.toBase58()} (authority: house, until handoff to ${goldenAuth.toBase58()})`);
process.exit(0);
