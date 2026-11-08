import { Connection, Keypair, type PublicKey, type Transaction } from "@solana/web3.js";
import { BASE_RPC, ER_RPC } from "@quickdraw/sdk";

/**
 * fetch with a few quick retries. Public devnet RPC rate-limits hard, and in a browser a 429 often
 * arrives without CORS headers, so it surfaces as "Failed to fetch" and web3.js never retries it.
 * JSON-RPC reads and sends are safe to repeat (a resent transaction has the same signature).
 */
const RETRIES = 4;
const BASE_URL = process.env.NEXT_PUBLIC_BASE_RPC || BASE_RPC;
/**
 * A configured RPC (e.g. a Helius key) can run out of credits or rate-limit; when it does, fall back
 * to the public endpoint at once and give the configured one another try a minute later.
 */
const FALLBACK: Record<string, string> = BASE_URL !== BASE_RPC ? { [BASE_URL]: BASE_RPC } : {};
const COOL_DOWN_MS = 60_000;
const downUntil: Record<string, number> = {};
const retryingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  for (let i = 0; ; i++) {
    const backup = FALLBACK[url];
    const target = backup && (downUntil[url] ?? 0) > Date.now() ? backup : url;
    try {
      const res = await fetch(target, init);
      // a bad or revoked key (401/403) is worth falling back from, not worth retrying
      const keyProblem = (res.status === 401 || res.status === 403) && target === url && !!backup;
      if ((res.status !== 429 && res.status < 500 && !keyProblem) || i >= RETRIES) return res;
    } catch (e) {
      if (i >= RETRIES) throw e;
    }
    if (target === url && backup) { downUntil[url] = Date.now() + COOL_DOWN_MS; continue; } // switch now, no wait
    await new Promise((r) => setTimeout(r, 250 * 2 ** i + Math.random() * 200));
  }
};

export const base = new Connection(BASE_URL, { commitment: "confirmed", fetch: retryingFetch });
export const er = new Connection(process.env.NEXT_PUBLIC_ER_RPC ?? ER_RPC, { commitment: "confirmed", fetch: retryingFetch });
export const KEEPER_URL = process.env.NEXT_PUBLIC_KEEPER_URL ?? "http://localhost:8787";

/** ER blockhash cache so a tap does not wait on an extra RPC round trip. */
let cachedHash = { value: "", at: 0 };
export async function erBlockhash(): Promise<string> {
  if (Date.now() - cachedHash.at > 3_000) cachedHash = { value: (await er.getLatestBlockhash()).blockhash, at: Date.now() };
  return cachedHash.value;
}

/** The signed-in player's Privy embedded wallet, which signs without popups. */
export interface AppSigner {
  kind: "wallet";
  publicKey: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  /** The player's Privy access token, which the keeper checks before covering fees. */
  authToken: () => Promise<string | null>;
}

const store = {
  get(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
  del(key: string) { try { localStorage.removeItem(key); } catch { /* private mode */ } },
};

function loadKey(key: string): Keypair | null {
  const raw = store.get(key);
  if (!raw) return null;
  try { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[])); } catch { return null; }
}
const saveKey = (key: string, kp: Keypair) => store.set(key, JSON.stringify([...kp.secretKey]));

/** The session key that taps for `owner` without wallet popups. */
export function sessionKey(owner: PublicKey, create: boolean): Keypair | null {
  const k = `qd-session-${owner.toBase58()}`;
  let kp = loadKey(k);
  if (!kp && create) { kp = Keypair.generate(); saveKey(k, kp); }
  return kp;
}

export const prefs = {
  theme: () => (store.get("qd-theme") === "light" ? "light" : "dark") as "light" | "dark",
  setTheme: (t: "light" | "dark") => store.set("qd-theme", t),
  stake: () => Number(store.get("qd-stake") ?? 1),
  setStake: (s: number) => store.set("qd-stake", String(s)),
  /** Responsible play: pause tapping once a session is down this many dollars (0 = off). */
  lossLimit: () => Number(store.get("qd-loss-limit") ?? 0),
  setLossLimit: (d: number) => store.set("qd-loss-limit", String(d)),
};
