"use client";

// Profile: the player's wallet (deposit, withdraw), their record, wallet-play allowance, and every
// on-chain receipt: stakes the house collected and payouts it sent, straight from Solana devnet.
import { useCallback, useEffect, useState } from "react";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { BASE_RPC, USDC_MINT, ataOf, decodePlayer, explainError, playerPda } from "@quickdraw/sdk";
import { LogoMark } from "./Logo";
import { decodeTokenAccount, useAccount, VAULT_HEX } from "@/lib/account";
import { base, er, prefs } from "@/lib/chain";
import { usePrivySigner } from "@/lib/privy";

const usd = (v: bigint | number) => {
  const n = typeof v === "bigint" ? Number(v) / 1e6 : v;
  return `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const solscan = (path: string) => `https://solscan.io/${path}?cluster=devnet`;

interface Receipt { sig: string; at: number; kind: string; delta: number }
const KIND: Record<string, string> = {
  CollectStake: "Stake taken by a tap", PayOut: "Winnings paid", Transfer: "Transfer", TransferChecked: "Transfer",
  Approve: "Wallet play enabled", Revoke: "Wallet play paused", Deposit: "Deposit (old game balance)", Withdraw: "Withdrawal (old game balance)",
};

/** Recent movements of the wallet's USDC token account, read over raw RPC (Magic Actions use v1 transactions). */
async function loadReceipts(owner: PublicKey): Promise<Receipt[]> {
  const ata = ataOf(owner);
  const sigs = (await base.getSignaturesForAddress(ata, { limit: 12 })).filter((s) => !s.err);
  const rpc = process.env.NEXT_PUBLIC_BASE_RPC ?? BASE_RPC;
  type Tx = { result?: { meta?: { logMessages?: string[]; preTokenBalances?: Bal[]; postTokenBalances?: Bal[] } } } | null;
  const getTx = async (sig: string): Promise<Tx> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(rpc, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] }),
      }).catch(() => null);
      if (res?.ok) return res.json() as Promise<Tx>;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); // the public RPC rate-limits bursts
    }
    return null;
  };
  // a few at a time: the public devnet RPC rejects bursts
  const txs: Tx[] = [];
  for (const s of sigs) { txs.push(await getTx(s.signature)); await new Promise((r) => setTimeout(r, 200)); }
  const out = sigs.map((s, i) => {
    const r = txs[i];
    const meta = r?.result?.meta;
    const logs = meta?.logMessages ?? [];
    const name = logs.map((l) => /Instruction: (\w+)/.exec(l)?.[1]).find((n) => n && n in KIND) ?? "Transfer";
    const bal = (list?: Bal[]) => BigInt(list?.find((b) => b.owner === owner.toBase58() && b.mint === USDC_MINT.toBase58())?.uiTokenAmount.amount ?? "0");
    const delta = Number(bal(meta?.postTokenBalances) - bal(meta?.preTokenBalances)) / 1e6;
    const kind = !meta ? "USDC movement"
      : name === "Transfer" || name === "TransferChecked" ? (delta > 0 ? "Received" : delta < 0 ? "Sent" : "Account update")
      : KIND[name]!;
    return { sig: s.signature, at: s.blockTime ?? 0, kind, delta };
  });
  return out;
}
interface Bal { owner?: string; mint: string; uiTokenAmount: { amount: string } }

export function Profile() {
  const auth = usePrivySigner();
  const signer = auth.signer;
  const account = useAccount(signer);
  const [sol, setSol] = useState<number | null>(null);
  const [allow, setAllow] = useState<{ on: boolean; left: bigint } | null>(null);
  const [stats, setStats] = useState<{ taps: number; wins: number; best: number; streak: number; pnl: bigint } | null>(null);
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);

  const refresh = useCallback(async () => {
    if (!signer) return;
    try { await load(signer.publicKey); } catch { /* the public RPC rate-limits bursts: the next refresh catches up */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signer]);
  const load = async (owner: PublicKey) => {
    const [lamports, ata, onEr] = await Promise.all([
      base.getBalance(owner), base.getAccountInfo(ataOf(owner)), er.getAccountInfo(playerPda(owner)).catch(() => null),
    ]);
    setSol(lamports / LAMPORTS_PER_SOL);
    const t = ata ? decodeTokenAccount(ata.data) : null;
    setAllow({ on: !!t && t.delegate === VAULT_HEX && t.delegated > 0n, left: t?.delegate === VAULT_HEX ? t.delegated : 0n });
    const info = onEr ?? (await base.getAccountInfo(playerPda(owner)));
    if (info) { const p = decodePlayer(info.data); setStats({ taps: p.tapsPlaced, wins: p.wins, best: p.bestStreak, streak: p.streak, pnl: p.pnl }); }
    setReceipts(await loadReceipts(owner).catch(() => []));
  };
  // load once, and again after a send or a pause finishes
  useEffect(() => { if (!account.busy) void refresh(); }, [account.busy, refresh]);

  if (!auth.ready) return <Shell><div className="card pad"><p className="empty">Loading…</p></div></Shell>;
  if (!auth.authenticated || !signer) {
    return (
      <Shell>
        <div className="card pad narrow">
          <h2 className="h2">Your profile</h2>
          <p className="muted">Sign in with Google or X to see your wallet, your record and every on-chain receipt.</p>
          <button className="btn primary" onClick={auth.login}>Continue with Google or X</button>
        </div>
      </Shell>
    );
  }
  const address = signer.publicKey.toBase58();
  const winRate = stats && stats.taps > 0 ? Math.round((stats.wins / stats.taps) * 100) : 0;

  return (
    <Shell onSignOut={() => void auth.logout().then(() => { location.href = "/"; })}>
      <div className="profile">
        <div className="pcol">
          <section className="card pad">
            <div className="ident">
              <span className="avatar lg" aria-hidden="true">{(auth.name ?? address).slice(0, 1).toUpperCase()}</span>
              <div>
                <h2 className="h2">{auth.name ?? "Player"}</h2>
                <CopyRow text={address} label={short(address)} />
              </div>
              <a className="btn ghost" href={solscan(`account/${address}`)} target="_blank" rel="noreferrer">Solscan ↗</a>
            </div>
            <div className="balance">
              <span className="muted">Wallet balance</span>
              <b>{usd(account.walletUsdc)}</b>
              <span className="muted small">devnet USDC · {sol === null ? "…" : `${sol.toFixed(3)} SOL for fees, covered by the house`}</span>
            </div>
          </section>
          <section className="card pad">
            <h3 className="h3">Deposit</h3>
            <p className="muted">Send devnet USDC to this address from any Solana wallet, or claim 20 free at Circle&apos;s faucet (USDC, Solana Devnet). It stays in your wallet; each tap takes only its stake.</p>
            <CopyRow text={address} label={address} mono />
            <a className="btn block" href="https://faucet.circle.com/" target="_blank" rel="noreferrer">Open Circle faucet ↗</a>
            <h3 className="h3 sep">Withdraw</h3>
            <Withdraw max={account.walletUsdc} busy={account.busy} onSend={account.sendUsdc} />
            {account.error && <p className="err">{account.error}</p>}
          </section>
        </div>

        <div className="pcol">
          <section className="card pad">
            <h3 className="h3">Record</h3>
            <div className="tiles">
              <div><span className="muted">P&amp;L</span><b className={stats && stats.pnl > 0n ? "win" : stats && stats.pnl < 0n ? "loss" : ""}>{stats ? `${stats.pnl > 0n ? "+" : ""}${usd(stats.pnl)}` : "—"}</b></div>
              <div><span className="muted">Taps</span><b>{stats?.taps ?? 0}</b></div>
              <div><span className="muted">Win rate</span><b>{winRate}%</b></div>
              <div><span className="muted">Best streak</span><b>{stats?.best ?? 0}</b></div>
            </div>
            <div className="kv"><span>Current streak</span><span>{stats?.streak ?? 0}</span></div>
            <div className="kv"><span>Wins</span><span>{stats?.wins ?? 0}</span></div>
            {account.legacyBalance > 0n && (
              <div className="kv"><span>Old game balance</span>
                <span><button className="linkbtn" onClick={account.withdrawLegacy}>Move {usd(account.legacyBalance)} to wallet</button></span></div>
            )}
          </section>
          <section className="card pad">
            <h3 className="h3">Wallet play</h3>
            <p className="muted">Your USDC never sits in a game account. Each tap&apos;s stake is pulled from your wallet by a MagicBlock Magic Action the program schedules, and winnings are sent straight back.</p>
            <div className="kv"><span>Status</span><span>{allow === null ? "…" : allow.on ? "On" : "Paused"}</span></div>
            <div className="kv"><span>Allowance left</span><span>{allow ? usd(allow.left) : "…"}</span></div>
            {allow?.on
              ? <button className="btn block" disabled={!!account.busy} onClick={account.pauseWalletPlay}>Pause wallet play</button>
              : <a className="btn primary block" href="/">Turn on in the game</a>}
            {account.busy && <p className="muted small">{account.busy}</p>}
          </section>
          <section className="card pad">
            <h3 className="h3">Responsible play</h3>
            <p className="muted">Pause tapping in this browser once a session is down this much. A session starts when you open the game.</p>
            <LossLimit />
          </section>
        </div>

        <div className="pcol last">
          <section className="card pad">
            <h3 className="h3">Achievements</h3>
            <div className="badges">
              {achievements(stats, receipts).map((a) => (
                <div key={a.name} className={`badge-a${a.done ? " done" : ""}`} title={a.how}>
                  <span className="bi" aria-hidden="true">{a.done ? a.icon : "·"}</span>
                  <span className="bn">{a.name}</span>
                  <span className="bh">{a.how}</span>
                </div>
              ))}
            </div>
          </section>
        <section className="card pad receipts">
          <div className="h3row"><h3 className="h3">On-chain receipts</h3><button className="linkbtn" onClick={() => void refresh()}>Refresh</button></div>
          <p className="muted small">Every USDC movement on your wallet, read from Solana devnet.</p>
          {receipts === null ? <p className="empty">Reading Solana devnet…</p> : receipts.length === 0 ? <p className="empty">No USDC movements yet.</p> : (
            <ul className="list scroll">
              {receipts.map((r) => (
                <li key={r.sig}>
                  <span className={`dotp${r.delta > 0 ? " won" : ""}`} />
                  <span className="rk"><span>{r.kind}</span><span className="who small">{r.at ? new Date(r.at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""}</span></span>
                  <span className={`amt ${r.delta > 0 ? "win" : r.delta < 0 ? "" : "who"}`}>{r.delta === 0 ? "—" : `${r.delta > 0 ? "+" : "−"}$${Math.abs(r.delta).toFixed(2)}`}</span>
                  <a className="linkbtn" href={solscan(`tx/${r.sig}`)} target="_blank" rel="noreferrer">tx ↗</a>
                </li>
              ))}
            </ul>
          )}
        </section>
        </div>
      </div>
    </Shell>
  );
}

interface Achievement { name: string; how: string; icon: string; done: boolean }
function achievements(stats: { taps: number; wins: number; best: number; pnl: bigint } | null, receipts: Receipt[] | null): Achievement[] {
  const s = stats ?? { taps: 0, wins: 0, best: 0, pnl: 0n };
  const bigWin = (receipts ?? []).some((r) => r.kind === KIND.PayOut && r.delta >= 10);
  return [
    { name: "First tap", how: "Place a tap", icon: "◆", done: s.taps >= 1 },
    { name: "First win", how: "Win a tap", icon: "✓", done: s.wins >= 1 },
    { name: "Hot hand", how: "3 wins in a row", icon: "▲", done: s.best >= 3 },
    { name: "On fire", how: "5 wins in a row", icon: "★", done: s.best >= 5 },
    { name: "Century", how: "100 taps", icon: "C", done: s.taps >= 100 },
    { name: "Sharpshooter", how: "25 wins", icon: "◎", done: s.wins >= 25 },
    { name: "In the green", how: "Overall P&L above zero", icon: "+", done: s.pnl > 0n },
    { name: "Big payout", how: "A single payout of $10+", icon: "$", done: bigWin },
  ];
}

function LossLimit() {
  const [limit, setLimit] = useState(0);
  useEffect(() => setLimit(prefs.lossLimit()), []);
  return (
    <div className="seg block" role="group" aria-label="Session loss limit">
      {[0, 10, 25, 50].map((d) => (
        <button key={d} aria-pressed={limit === d} onClick={() => { prefs.setLossLimit(d); setLimit(d); }}>{d === 0 ? "Off" : `$${d}`}</button>
      ))}
    </div>
  );
}

function Withdraw({ max, busy, onSend }: { max: bigint; busy: string | null; onSend: (to: PublicKey, amount: bigint) => Promise<void> | void }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [confirm, setConfirm] = useState(false);
  let dest: PublicKey | null = null;
  try { dest = to.trim() ? new PublicKey(to.trim()) : null; } catch { dest = null; }
  const units = BigInt(Math.round((Number(amount) || 0) * 1e6));
  const problem = !to.trim() ? null : !dest ? "That is not a Solana address" : units <= 0n ? null : units > max ? "More than your wallet holds" : null;
  const ready = !!dest && units > 0n && units <= max;
  return (
    <form className="wform" onSubmit={(e) => { e.preventDefault(); if (!ready || !dest) return; if (!confirm) { setConfirm(true); return; } void Promise.resolve(onSend(dest, units)).then(() => setConfirm(false)); }}>
      <label className="field"><span>To</span>
        <input value={to} onChange={(e) => { setTo(e.target.value); setConfirm(false); }} placeholder="Solana address" spellCheck={false} autoComplete="off" />
      </label>
      <label className="field"><span>Amount (USDC)</span>
        <div className="inrow">
          <input value={amount} onChange={(e) => { setAmount(e.target.value.replace(/[^0-9.]/g, "")); setConfirm(false); }} inputMode="decimal" placeholder="0.00" autoComplete="off" />
          <button type="button" className="linkbtn" onClick={() => setAmount((Number(max) / 1e6).toFixed(2))}>Max</button>
        </div>
      </label>
      {problem && <p className="err">{problem}</p>}
      <button className="btn primary" type="submit" disabled={!ready || !!busy}>
        {busy ?? (confirm && dest ? `Confirm: send ${usd(units)} to ${short(dest.toBase58())}` : "Send")}
      </button>
    </form>
  );
}

function CopyRow({ text, label, mono }: { text: string; label: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className={`copyrow${mono ? " mono" : ""}`} title="Copy" onClick={() => void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {})}>
      <span>{label}</span><span className="muted small">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function Shell({ children, onSignOut }: { children: React.ReactNode; onSignOut?: () => void }) {
  useEffect(() => {
    try { const t = localStorage.getItem("qd-theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch { /* private mode */ }
  }, []);
  return (
    <main className="app">
      <header className="top">
        <a className="brand" href="/" aria-label="Quickdraw home"><LogoMark size={28} /><span className="word">Quickdraw</span></a>
        <div className="right">
          <a className="btn ghost" href="/">← Back to the game</a>
          {onSignOut && <button className="btn" onClick={onSignOut}>Sign out</button>}
        </div>
      </header>
      {children}
    </main>
  );
}

// keep explainError in the bundle for error text parity with the game
void explainError;
