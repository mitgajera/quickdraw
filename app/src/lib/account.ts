// Where the connected wallet is in the onboarding flow, and the one-click actions that move it on.
// Rollup transactions are free, so the session key needs no SOL of its own.
import { useCallback, useEffect, useRef, useState } from "react";
import { LAMPORTS_PER_SOL, type TransactionInstruction } from "@solana/web3.js";
import {
  PROGRAM_ID, USD, ataOf, buildTx, decodePlayer, explainError, ix, playerPda, sendSigned,
} from "@quickdraw/sdk";
import { KEEPER_URL, base, er, sessionKey, type AppSigner } from "./chain";

export type Stage = "disconnected" | "checking" | "new" | "undelegated" | "session" | "ready";

const SESSION_SECONDS = 24 * 60 * 60;
const START_BALANCE = 1_000n * USD;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useAccount(signer: AppSigner | null) {
  const [stage, setStage] = useState<Stage>("disconnected");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signerRef = useRef(signer);
  signerRef.current = signer;

  const check = useCallback(async (): Promise<Stage> => {
    const s = signerRef.current;
    if (!s) { setStage("disconnected"); return "disconnected"; }
    const pda = playerPda(s.publicKey);
    const info = await base.getAccountInfo(pda);
    let next: Stage;
    if (!info) next = "new";
    else if (info.owner.equals(PROGRAM_ID)) next = "undelegated";
    else {
      const onEr = await er.getAccountInfo(pda);
      const session = sessionKey(s.publicKey, false);
      const p = onEr ? decodePlayer(onEr.data) : null;
      next = p && session && p.session.equals(session.publicKey) && p.sessionExpires > Date.now() / 1000 + 60 ? "ready" : "session";
    }
    if (signerRef.current === s) setStage(next);
    return next;
  }, []);

  useEffect(() => {
    setError(null);
    setStage(signer ? "checking" : "disconnected");
    void check().catch((e) => setError(explainError(e)));
  }, [signer, check]);

  const send = async (conn: typeof base, ixs: TransactionInstruction[]) => {
    const s = signerRef.current!;
    const { tx } = await buildTx(conn, ixs, s.publicKey);
    const signed = await s.signTransaction(tx);
    return sendSigned(conn, signed, { pollMs: conn === base ? 500 : 30, timeoutMs: 60_000 });
  };

  /** Guest wallets start empty: the keeper tops them up with a little devnet SOL for rent. */
  const ensureSol = async () => {
    const s = signerRef.current!;
    if ((await base.getBalance(s.publicKey)) >= 0.02 * LAMPORTS_PER_SOL) return;
    setBusy("Funding your guest wallet…");
    const res = await fetch(`${KEEPER_URL}/sponsor`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: s.publicKey.toBase58() }),
    }).then((r) => r.json() as Promise<{ ok?: boolean; reason?: string; error?: string }>);
    if (!res.ok) throw new Error(res.error ?? res.reason ?? "Could not fund the guest wallet");
    for (let i = 0; i < 40; i++) {
      if ((await base.getBalance(s.publicKey)) >= 0.02 * LAMPORTS_PER_SOL) return;
      await sleep(750);
    }
    throw new Error("Guest wallet funding did not arrive");
  };

  /** Takes the wallet from wherever it is to "ready" with as few signatures as possible. */
  const activate = useCallback(async () => {
    const s = signerRef.current;
    if (!s) return;
    setError(null);
    try {
      const owner = s.publicKey;
      const current = await check();
      const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
      if (current === "new" || current === "undelegated") {
        if (s.kind === "guest") await ensureSol();
        const session = sessionKey(owner, true)!;
        const ixs: TransactionInstruction[] = [];
        if (current === "new") {
          ixs.push(ix.faucet(owner), ix.initPlayer(owner), ix.deposit(owner, START_BALANCE));
        } else {
          const ata = await base.getTokenAccountBalance(ataOf(owner)).catch(() => null);
          const amount = BigInt(ata?.value.amount ?? "0");
          if (amount > 0n) ixs.push(ix.deposit(owner, amount));
        }
        ixs.push(ix.setSession(owner, session.publicKey, expires), ix.delegatePlayer(owner));
        setBusy(current === "new" ? "Minting $1,000 test USD and opening your account…" : "Moving your balance into the rollup…");
        await send(base, ixs);
      } else if (current === "session") {
        const session = sessionKey(owner, true)!;
        setBusy("Authorising this browser to tap…");
        await send(er, [ix.setSession(owner, session.publicKey, expires)]);
      }
      setBusy("Waiting for the rollup…");
      for (let i = 0; i < 40; i++) {
        if ((await check()) === "ready") break;
        await sleep(750);
      }
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(null);
    }
  }, [check]);

  return { stage, busy, error, activate, recheck: check };
}
