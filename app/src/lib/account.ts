// Where the connected wallet is in the onboarding flow, and the actions that move it on: deposit
// devnet USDC and open the account, add funds, cash out. Rollup transactions are free, so the
// session key needs no SOL of its own.
import { useCallback, useEffect, useRef, useState } from "react";
import { LAMPORTS_PER_SOL, type TransactionInstruction } from "@solana/web3.js";
import {
  PROGRAM_ID, ataOf, buildTx, decodePlayer, explainError, ix, playerPda, sendSigned,
} from "@quickdraw/sdk";
import { KEEPER_URL, base, er, sessionKey, type AppSigner } from "./chain";

export type Stage = "disconnected" | "checking" | "new" | "undelegated" | "session" | "ready";

const SESSION_SECONDS = 24 * 60 * 60;
/** activate() fails with this when the wallet has no USDC and the starter grants have run out. */
export const NEEDS_USDC = "Your wallet needs devnet USDC to play";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useAccount(signer: AppSigner | null) {
  const [stage, setStage] = useState<Stage>("disconnected");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Devnet USDC still in the wallet (not yet deposited), in 6-decimal units. */
  const [walletUsdc, setWalletUsdc] = useState<bigint>(0n);
  const signerRef = useRef(signer);
  signerRef.current = signer;

  const readWalletUsdc = useCallback(async () => {
    const s = signerRef.current;
    if (!s) return 0n;
    const r = await base.getTokenAccountBalance(ataOf(s.publicKey)).catch(() => null);
    const amount = BigInt(r?.value.amount ?? "0");
    if (signerRef.current === s) setWalletUsdc(amount);
    return amount;
  }, []);

  const check = useCallback(async (): Promise<Stage> => {
    const s = signerRef.current;
    if (!s) { setStage("disconnected"); return "disconnected"; }
    const pda = playerPda(s.publicKey);
    const [info] = await Promise.all([base.getAccountInfo(pda), readWalletUsdc()]);
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
  }, [readWalletUsdc]);

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

  /**
   * The house pays every fee: the keeper sends a new wallet devnet SOL for base-layer fees and rent,
   * plus starter USDC while its welcome budget lasts. Players never need SOL.
   */
  const ensureFunded = async (wantUsdc: boolean) => {
    const s = signerRef.current!;
    const hasSol = async () => (await base.getBalance(s.publicKey)) >= 0.02 * LAMPORTS_PER_SOL;
    if ((await hasSol()) && !wantUsdc) return;
    setBusy(wantUsdc ? "Sending you starter USDC…" : "Covering your network fees…");
    const token = await s.authToken().catch(() => null);
    const res = await fetch(`${KEEPER_URL}/welcome`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ wallet: s.publicKey.toBase58() }),
    }).then((r) => r.json() as Promise<{ ok?: boolean; usdc?: number; error?: string }>).catch(() => ({ ok: false, usdc: 0, error: "the game server is waking up, try again in a moment" }));
    if (!res.ok) throw new Error(`Could not set up your wallet: ${res.error ?? "unknown error"}`);
    for (let i = 0; i < 40; i++) {
      if ((await hasSol()) && (!res.usdc || (await readWalletUsdc()) > 0n)) return;
      await sleep(750);
    }
    throw new Error("Setup is taking longer than usual, try again in a moment");
  };

  const waitForBase = async (delegated: boolean) => {
    const pda = playerPda(signerRef.current!.publicKey);
    for (let i = 0; i < 60; i++) {
      const owner = (await base.getAccountInfo(pda))?.owner;
      if (owner && owner.equals(PROGRAM_ID) !== delegated) return;
      await sleep(750);
    }
    throw new Error("The rollup did not hand the account back in time — try again in a moment");
  };

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    if (!signerRef.current) return;
    setError(null);
    setBusy(label);
    try {
      await fn();
      setBusy("Waiting for the rollup…");
      await check();
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(null);
    }
  }, [check]);

  /** Deposits the wallet's devnet USDC and gets to "ready" with one signature where possible. */
  const activate = useCallback(() => run("Opening your account…", async () => {
    const owner = signerRef.current!.publicKey;
    const current = await check();
    const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    if (current === "new" || current === "undelegated") {
      await ensureFunded(current === "new" && (await readWalletUsdc()) === 0n);
      const amount = await readWalletUsdc();
      if (current === "new" && amount === 0n) throw new Error(NEEDS_USDC);
      const session = sessionKey(owner, true)!;
      const ixs: TransactionInstruction[] = [];
      if (current === "new") ixs.push(ix.initPlayer(owner));
      if (amount > 0n) ixs.push(ix.deposit(owner, amount));
      ixs.push(ix.setSession(owner, session.publicKey, expires), ix.delegatePlayer(owner));
      setBusy(amount > 0n ? `Depositing ${(Number(amount) / 1e6).toFixed(2)} USDC…` : "Moving your account into the rollup…");
      await send(base, ixs);
    } else if (current === "session") {
      const session = sessionKey(owner, true)!;
      setBusy("Authorising this browser to tap…");
      await send(er, [ix.setSession(owner, session.publicKey, expires)]);
    }
    for (let i = 0; i < 40 && (await check()) !== "ready"; i++) await sleep(750);
  }), [run, check, readWalletUsdc]);

  /** Takes the account off the rollup and withdraws its whole balance to the wallet. */
  const cashOut = useCallback(() => run("Closing your session on the rollup…", async () => {
    const owner = signerRef.current!.publicKey;
    await ensureFunded(false);
    if ((await check()) !== "undelegated") {
      await send(er, [ix.undelegatePlayer(owner)]);
      setBusy("Settling back to Solana…");
      await waitForBase(false);
    }
    const info = await base.getAccountInfo(playerPda(owner));
    const balance = info ? decodePlayer(info.data).balance : 0n;
    if (balance > 0n) {
      setBusy(`Withdrawing ${(Number(balance) / 1e6).toFixed(2)} USDC…`);
      await send(base, [ix.withdraw(owner, balance)]);
    }
  }), [run, check]);

  /** Tops the game balance up with whatever devnet USDC is in the wallet. */
  const addFunds = useCallback(() => run("Closing your session on the rollup…", async () => {
    const owner = signerRef.current!.publicKey;
    const amount = await readWalletUsdc();
    if (amount === 0n) throw new Error("No devnet USDC in this wallet to add (faucet.circle.com, Solana Devnet)");
    await ensureFunded(false);
    if ((await check()) !== "undelegated") {
      await send(er, [ix.undelegatePlayer(owner)]);
      setBusy("Settling back to Solana…");
      await waitForBase(false);
    }
    const session = sessionKey(owner, true)!;
    setBusy(`Depositing ${(Number(amount) / 1e6).toFixed(2)} USDC…`);
    await send(base, [
      ix.deposit(owner, amount),
      ix.setSession(owner, session.publicKey, Math.floor(Date.now() / 1000) + SESSION_SECONDS),
      ix.delegatePlayer(owner),
    ]);
    await waitForBase(true);
    for (let i = 0; i < 40 && (await check()) !== "ready"; i++) await sleep(750);
  }), [run, check, readWalletUsdc]);

  return { stage, busy, error, walletUsdc, activate, cashOut, addFunds, recheck: check };
}
