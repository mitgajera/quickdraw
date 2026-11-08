// Wallet play: the player's devnet USDC stays in their own wallet. Setup is one silent transaction
// (allowance for the house vault, a ledger, the player account on the rollup); after that each tap's
// stake is pulled from the wallet on Solana by a Magic Action, and winnings are paid straight back.
// Rollup transactions are free, so the session key needs no SOL of its own.
import { useCallback, useEffect, useRef, useState } from "react";
import { Buffer } from "buffer";
import { LAMPORTS_PER_SOL, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID, PROGRAM_ID, WALLET_ALLOWANCE, ataOf, buildTx, createAtaIdempotent, decodeLedger, decodePlayer,
  explainError, ix, ledgerPda, playerPda, sendSigned, transferTokens, vaultPda,
} from "@quickdraw/sdk";
import { KEEPER_URL, base, er, sessionKey, type AppSigner } from "./chain";

export type Stage = "disconnected" | "checking" | "setup" | "session" | "ready";

const SESSION_SECONDS = 24 * 60 * 60;
/** Re-approve once the remaining allowance drops below this (100 USDC). */
const ALLOWANCE_FLOOR = 100_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The parts of an SPL token account the game cares about. */
export interface WalletTokens { amount: bigint; delegate: string | null; delegated: bigint }
export function decodeTokenAccount(data: Uint8Array): WalletTokens {
  const b = Buffer.from(data);
  const hasDelegate = b.readUInt32LE(72) === 1;
  return {
    amount: b.readBigUInt64LE(64),
    delegate: hasDelegate ? Buffer.from(b.subarray(76, 108)).toString("hex") : null,
    delegated: b.readBigUInt64LE(121),
  };
}
export const VAULT_HEX = Buffer.from(vaultPda().toBytes()).toString("hex");

export function useAccount(signer: AppSigner | null) {
  const [stage, setStage] = useState<Stage>("disconnected");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Devnet USDC in the wallet (6 decimals): this is the player's balance. */
  const [walletUsdc, setWalletUsdc] = useState<bigint>(0n);
  /** Ids of wallet taps whose stake has been collected on Solana (from the ledger). */
  const [collected, setCollected] = useState<Set<number>>(new Set());
  /** Balance left in the old deposit-based game account, if any (can be withdrawn). */
  const [legacyBalance, setLegacyBalance] = useState<bigint>(0n);
  const signerRef = useRef(signer);
  signerRef.current = signer;

  /** Wallet USDC, allowance and the ledger, in one read. */
  const readWallet = useCallback(async () => {
    const s = signerRef.current;
    if (!s) return null;
    const [ata, ledger] = await base.getMultipleAccountsInfo([ataOf(s.publicKey), ledgerPda(s.publicKey)]);
    const tokens = ata ? decodeTokenAccount(ata.data) : { amount: 0n, delegate: null, delegated: 0n };
    const led = ledger ? decodeLedger(ledger.data) : null;
    if (signerRef.current === s) {
      setWalletUsdc(tokens.amount);
      if (led) setCollected(new Set(led.collected.filter((id) => id !== 0)));
    }
    return { tokens, ledger: led };
  }, []);

  const check = useCallback(async (): Promise<Stage> => {
    const s = signerRef.current;
    if (!s) { setStage("disconnected"); return "disconnected"; }
    const pda = playerPda(s.publicKey);
    const [info, w] = await Promise.all([base.getAccountInfo(pda), readWallet()]);
    const approved = !!w && w.tokens.delegate === VAULT_HEX && w.tokens.delegated >= ALLOWANCE_FLOOR;
    let next: Stage;
    if (!info || !w?.ledger || !approved || !info.owner.equals(DELEGATION_PROGRAM_ID)) next = "setup";
    else {
      const onEr = await er.getAccountInfo(pda);
      const session = sessionKey(s.publicKey, false);
      const p = onEr ? decodePlayer(onEr.data) : null;
      if (p && signerRef.current === s) setLegacyBalance(p.balance);
      next = p && session && p.session.equals(session.publicKey) && p.sessionExpires > Date.now() / 1000 + 60 ? "ready" : "session";
    }
    if (info && info.owner.equals(PROGRAM_ID) && signerRef.current === s) setLegacyBalance(decodePlayer(info.data).balance);
    if (signerRef.current === s) setStage(next);
    return next;
  }, [readWallet]);

  useEffect(() => {
    setError(null);
    setStage(signer ? "checking" : "disconnected");
    void check().catch((e) => setError(explainError(e)));
  }, [signer, check]);

  // the wallet is the balance: keep it live (stakes leave and winnings arrive on Solana)
  useEffect(() => {
    if (!signer) return;
    const id = setInterval(() => { if (!document.hidden) void readWallet().catch(() => {}); }, 1500);
    return () => clearInterval(id);
  }, [signer, readWallet]);

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
    const hasSol = async () => (await base.getBalance(s.publicKey)) >= 0.01 * LAMPORTS_PER_SOL;
    if ((await hasSol()) && !wantUsdc) return;
    setBusy(wantUsdc ? "Sending you starter USDC…" : "Covering your network fees…");
    const token = await s.authToken().catch(() => null);
    const res = await fetch(`${KEEPER_URL}/welcome`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ wallet: s.publicKey.toBase58() }),
    }).then((r) => r.json() as Promise<{ ok?: boolean; usdc?: number; error?: string }>).catch(() => ({ ok: false, usdc: 0, error: "the game server is waking up, try again in a moment" }));
    if (!res.ok) {
      if (await hasSol()) return; // starter USDC is a bonus; fees are what setup needs
      throw new Error(`Could not set up your wallet: ${res.error ?? "unknown error"}`);
    }
    for (let i = 0; i < 40; i++) {
      if ((await hasSol()) && (!res.usdc || (await readWallet())!.tokens.amount > 0n)) return;
      await sleep(750);
    }
    throw new Error("Setup is taking longer than usual, try again in a moment");
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

  /**
   * Gets to "ready" with one silent transaction: allow the house vault to spend USDC from the wallet
   * (it stays in the wallet), open the ledger and player account, and move the account to the rollup.
   */
  const activate = useCallback(() => run("Setting up…", async () => {
    const owner = signerRef.current!.publicKey;
    const current = await check();
    const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    if (current === "setup") {
      const w = await readWallet();
      await ensureFunded(!w || w.tokens.amount === 0n);
      const [info, ledger, ata] = await base.getMultipleAccountsInfo([playerPda(owner), ledgerPda(owner), ataOf(owner)]);
      const tokens = ata ? decodeTokenAccount(ata.data) : null;
      const session = sessionKey(owner, true)!;
      const ixs: TransactionInstruction[] = [];
      if (!ata) ixs.push(createAtaIdempotent(owner, owner));
      if (!info) ixs.push(ix.initPlayer(owner));
      if (!ledger) ixs.push(ix.initLedger(owner));
      if (!tokens || tokens.delegate !== VAULT_HEX || tokens.delegated < ALLOWANCE_FLOOR) ixs.push(ix.approveVault(owner, WALLET_ALLOWANCE));
      if (!info || info.owner.equals(PROGRAM_ID)) ixs.push(ix.setSession(owner, session.publicKey, expires), ix.delegatePlayer(owner));
      setBusy("Connecting your wallet to the game…");
      if (ixs.length) await send(base, ixs);
      for (let i = 0; i < 40 && (await check()) === "setup"; i++) await sleep(750);
    }
    if ((await check()) === "session") {
      const session = sessionKey(owner, true)!;
      setBusy("Authorising this browser to tap…");
      await send(er, [ix.setSession(owner, session.publicKey, expires)]);
    }
    for (let i = 0; i < 40 && (await check()) !== "ready"; i++) await sleep(750);
  }), [run, check, readWallet]);

  /** Moves a balance left in the old deposit-based game account back to the wallet. */
  const withdrawLegacy = useCallback(() => run("Closing your old game balance…", async () => {
    const owner = signerRef.current!.publicKey;
    await ensureFunded(false);
    const pda = playerPda(owner);
    if (!(await base.getAccountInfo(pda))?.owner.equals(PROGRAM_ID)) {
      for (let i = 0; i < 90; i++) {
        const p = await er.getAccountInfo(pda);
        if (!p || decodePlayer(p.data).taps.every((t) => !t.open)) break;
        setBusy("Waiting for open taps to settle…");
        await sleep(1000);
      }
      await send(er, [ix.undelegatePlayer(owner)]);
      setBusy("Settling back to Solana…");
      for (let i = 0; i < 60 && !(await base.getAccountInfo(pda))?.owner.equals(PROGRAM_ID); i++) await sleep(750);
    }
    const balance = decodePlayer((await base.getAccountInfo(pda))!.data).balance;
    if (balance > 0n) {
      setBusy(`Moving ${(Number(balance) / 1e6).toFixed(2)} USDC to your wallet…`);
      await send(base, [ix.withdraw(owner, balance)]);
    }
    setLegacyBalance(0n);
  }), [run]);

  /** Sends devnet USDC from the wallet to any Solana address (creating its token account if needed). */
  const sendUsdc = useCallback((to: PublicKey, amount: bigint) => run(`Sending ${(Number(amount) / 1e6).toFixed(2)} USDC…`, async () => {
    const owner = signerRef.current!.publicKey;
    await ensureFunded(false);
    await send(base, [createAtaIdempotent(owner, to), transferTokens(owner, to, amount)]);
    await readWallet();
  }), [run, readWallet]);

  /** Revokes the game's allowance: taps stop until wallet play is set up again. */
  const pauseWalletPlay = useCallback(() => run("Pausing wallet play…", async () => {
    await ensureFunded(false);
    await send(base, [ix.revokeVault(signerRef.current!.publicKey)]);
  }), [run]);

  return {
    stage, busy, error, walletUsdc, collected, legacyBalance, activate, withdrawLegacy, recheck: check, refreshWallet: readWallet,
    sendUsdc, pauseWalletPlay,
  };
}
