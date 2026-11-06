import { Connection, Keypair, Transaction, type TransactionInstruction, type PublicKey } from "@solana/web3.js";
import { IDL } from "./instructions";

const ERROR_NAMES: Record<number, string> = {};
// program error codes start at 6000 in IDL order
(IDL as unknown as { errors?: { code: number; name: string; msg?: string }[] }).errors?.forEach((e) => {
  ERROR_NAMES[e.code] = e.msg ?? e.name;
});

export class TxError extends Error {
  constructor(message: string, readonly signature: string | null, readonly logs: string[] = []) {
    super(message);
  }
}

/** Turns a raw RPC/program failure into the program's own error message when there is one. */
export function explainError(err: unknown, logs: string[] = []): string {
  const text = `${err instanceof Error ? err.message : JSON.stringify(err)}\n${logs.join("\n")}`;
  const anchor = text.match(/Error Message: ([^.\n]+)/);
  if (anchor) return anchor[1]!;
  const custom = text.match(/custom program error: 0x([0-9a-f]+)/i) ?? text.match(/"Custom":(\d+)/);
  if (custom) {
    const code = custom[0].startsWith("custom") ? parseInt(custom[1]!, 16) : Number(custom[1]);
    return ERROR_NAMES[code] ?? `program error ${code}`;
  }
  return text.split("\n")[0]!.slice(0, 160);
}

export interface Sent { signature: string; ms: number; logs: string[] }

export interface SendOptions {
  skipPreflight?: boolean;
  /** Poll interval while waiting for confirmation. */
  pollMs?: number;
  /** Fetch the transaction's logs after confirmation (for events). */
  withLogs?: boolean;
  /** Give up after this long. */
  timeoutMs?: number;
}

/** Wraps instructions in a transaction for `feePayer`, without signing. */
export async function buildTx(conn: Connection, ixs: TransactionInstruction[], feePayer: PublicKey) {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = feePayer;
  return { tx, lastValidBlockHeight };
}

/** Sends an already-signed transaction and confirms it by polling (no websockets needed). */
export async function sendSigned(conn: Connection, tx: Transaction, opts: SendOptions = {}): Promise<Sent> {
  const { skipPreflight = false, pollMs = 20, withLogs = false, timeoutMs = 30_000 } = opts;
  const t0 = performance.now();
  let signature: string;
  try {
    signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight, maxRetries: 3 });
  } catch (e) {
    const logs = (e as { logs?: string[] }).logs ?? [];
    throw new TxError(explainError(e, logs), null, logs);
  }
  for (;;) {
    const { value: [st] } = await conn.getSignatureStatuses([signature]);
    if (st?.err) {
      const t = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
      const logs = t?.meta?.logMessages ?? [];
      throw new TxError(explainError(st.err, logs), signature, logs);
    }
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") break;
    if (performance.now() - t0 > timeoutMs) throw new TxError("Transaction was not confirmed in time", signature);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const ms = performance.now() - t0;
  let logs: string[] = [];
  if (withLogs) {
    for (let i = 0; i < 15 && logs.length === 0; i++) {
      const t = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
      logs = t?.meta?.logMessages ?? [];
      if (logs.length === 0) await new Promise((r) => setTimeout(r, 150));
    }
  }
  return { signature, ms, logs };
}

/** Builds, signs with local keypairs (first one pays), sends and confirms. */
export async function sendWithKeypairs(
  conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], opts?: SendOptions,
): Promise<Sent> {
  const { tx } = await buildTx(conn, ixs, signers[0]!.publicKey);
  tx.sign(...signers);
  return sendSigned(conn, tx, opts);
}
