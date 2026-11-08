import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import { ATA_PROGRAM_ID, DELEGATION_PROGRAM_ID, ORACLES, PROGRAM_ID, TOKEN_PROGRAM_ID, USDC_MINT, type Symbol } from "./constants";

const find = (seeds: (Buffer | Uint8Array)[], program = PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];
const s = (text: string) => Buffer.from(text);

export const bookPda = () => find([s("book")]);
export const vaultPda = () => find([s("vault")]);
export const vaultTokensPda = () => find([s("vault-tokens")]);
export const marketPda = (oracle: PublicKey) => find([s("mkt"), oracle.toBuffer()]);
export const candlesPda = (market: PublicKey) => find([s("candles"), market.toBuffer()]);
export const playerPda = (owner: PublicKey) => find([s("player"), owner.toBuffer()]);
/** Wallet play: the base-layer record of collected stakes (never delegated). */
export const ledgerPda = (owner: PublicKey) => find([s("ledger"), owner.toBuffer()]);
/** Signs the program's Magic Actions. */
export const escrowAuthPda = () => find([s("escrow-auth")]);
/** SOL escrow the delegation program spends to run those actions on Solana (index 255). */
export const actionEscrowPda = () => find([s("balance"), escrowAuthPda().toBuffer(), Uint8Array.from([255])], DELEGATION_PROGRAM_ID);
export const ataOf = (owner: PublicKey, mint = USDC_MINT) =>
  find([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID);

/** Everything the program needs to know about one market. */
export interface MarketKeys {
  symbol: Symbol;
  oracle: PublicKey;
  market: PublicKey;
  candles: PublicKey;
}

export function marketKeys(symbol: Symbol): MarketKeys {
  const oracle = ORACLES[symbol];
  const market = marketPda(oracle);
  return { symbol, oracle, market, candles: candlesPda(market) };
}
