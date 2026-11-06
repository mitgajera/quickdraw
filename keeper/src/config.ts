import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { BASE_RPC, ER_RPC, type Symbol } from "@quickdraw/sdk";

const env = (name: string, fallback: string) => process.env[name] ?? fallback;

export const config = {
  baseRpc: env("BASE_RPC", BASE_RPC),
  erRpc: env("ER_RPC", ER_RPC),
  /** Pays for ticks and settlements (rollup transactions are free) and SOL top-ups. */
  keypairPath: env("KEEPER_KEYPAIR", path.join(os.homedir(), ".config", "solana", "id.json")),
  /** The house: owns the book and markets and provides the USDC bankroll (bootstrap only). */
  houseKeypairPath: env("HOUSE_KEYPAIR", env("KEEPER_KEYPAIR", path.join(os.homedir(), ".config", "solana", "id.json"))),
  markets: env("MARKETS", "SOL").split(",").map((s) => s.trim().toUpperCase()) as Symbol[],
  tickMs: Number(env("TICK_MS", "125")),
  settleMs: Number(env("SETTLE_MS", "400")),
  port: Number(env("PORT", "8787")),
  /** Devnet SOL sent to a new player wallet that has none, for base-layer fees and rent. */
  sponsorLamports: Number(env("SPONSOR_LAMPORTS", String(30_000_000))),
};

const parseSecret = (json: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(json) as number[]));

export function loadKeypair(file = config.keypairPath): Keypair {
  return parseSecret(fs.readFileSync(file, "utf8"));
}

/**
 * The keeper's key: `KEEPER_SECRET` (the keypair file's JSON array, for hosts like Render where
 * secrets are environment variables) or else the file at `KEEPER_KEYPAIR`.
 */
export function keeperKeypair(): Keypair {
  const secret = process.env.KEEPER_SECRET?.trim();
  return secret ? parseSecret(secret) : loadKeypair(config.keypairPath);
}
