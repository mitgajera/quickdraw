import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("ALSvgxDgSnXBdHYVgZtBW69CBusRn6s5Q17Wzn36aT8D");
export const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const ORACLE_PROGRAM_ID = new PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** Solana devnet (deposits, withdrawals, delegation). */
export const BASE_RPC = "https://api.devnet.solana.com";
/** MagicBlock ephemeral rollup, Asia region (taps, ticks, settlement). */
export const ER_RPC = "https://devnet-as.magicblock.app";
/** Validator identity of the Asia ER, passed when delegating accounts. */
export const ER_VALIDATOR = new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");

/** Test USD, like USDC: 6 decimals. */
export const USD_DECIMALS = 6;
export const USD = 1_000_000n;
/** Oracle prices carry 8 decimals. */
export const PRICE_DECIMALS = 8;
export const PRICE_SCALE = 100_000_000;

// mirrors of the on-chain constants (programs/quickdraw/src/lib.rs)
export const TAP_LOCK_SECS = 1;
export const MAX_AHEAD_SECS = 120;
export const VOL_WINDOW_SECS = 30;
/** Scales on the candle volatility estimate: drift before a column opens, wander inside it (lib.rs). */
export const DRIFT_VOL_SCALE = 2.5;
export const WINDOW_VOL_SCALE = 1.0;
export const MIN_VOL_SAMPLES = 5;
/** Grid zoom: rows are `market.band << zoom`, zoom 0..MAX_ZOOM (lib.rs `MAX_ZOOM`). */
export const MAX_ZOOM = 4;
export const CANDLE_SLOTS = 256;
export const MAX_TAPS = 12;
export const ONE_X_BPS = 10_000;
export const SETTLE_TIMEOUT_SECS = 30;

export type Symbol = "SOL" | "BTC" | "ETH";

/** MagicBlock ephemeral-oracle feeds (Pyth Lazer) on the ER. */
export const ORACLES: Record<Symbol, PublicKey> = {
  SOL: new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu"),
  BTC: new PublicKey("71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr"),
  ETH: new PublicKey("5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG"),
};

/** Account sizes (with the 8-byte discriminator), used as getProgramAccounts filters. */
export const PLAYER_SIZE = 1093;
export const CANDLES_SIZE = 6208;
