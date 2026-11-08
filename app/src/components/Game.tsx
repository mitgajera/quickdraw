"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { ComputeBudgetProgram, Transaction } from "@solana/web3.js";
import { ER_RPC, PROGRAM_ID, explainError, ix, playerPda, rowHeight, sendSigned, type Symbol } from "@quickdraw/sdk";
import type { PublicKey } from "@solana/web3.js";
import { Board } from "./Board";
import { useAccount, type Stage } from "@/lib/account";
import { erBlockhash, er, prefs, sessionKey, type AppSigner } from "@/lib/chain";
import { LiveModel, type Result } from "@/lib/live";
import { sound } from "@/lib/sound";

const SYMBOLS: Symbol[] = ["SOL", "BTC", "ETH"];
const STAKES = [0.5, 1, 2, 5];
const TAP_COMPUTE_UNITS = 400_000;
const DECIMALS: Record<Symbol, number> = { SOL: 4, BTC: 1, ETH: 2 };
const usd = (v: bigint | number) => {
  const n = typeof v === "bigint" ? Number(v) / 1e6 : v;
  return `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-3)}`;

export function Game() {
  const wallet = useWallet();
  const signer = useMemo<AppSigner | null>(() => {
    if (wallet.publicKey && wallet.signTransaction) {
      return { kind: "wallet", publicKey: wallet.publicKey, signTransaction: wallet.signTransaction };
    }
    return null;
  }, [wallet.publicKey, wallet.signTransaction]);

  const [symbol, setSymbol] = useState<Symbol>("SOL");
  const model = useMemo(() => new LiveModel(symbol), [symbol]);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => { model.start(); const off = model.subscribe(rerender); return () => { off(); model.stop(); }; }, [model]);
  useEffect(() => { model.setOwner(signer?.publicKey ?? null); }, [model, signer]);

  const account = useAccount(signer);

  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => setTheme(prefs.theme()), []);
  useEffect(() => { document.documentElement.dataset.theme = theme; prefs.setTheme(theme); }, [theme]);

  const [stake, setStake] = useState(5);
  useEffect(() => setStake(prefs.stake()), []);

  const [soundOn, setSoundOn] = useState(true);
  useEffect(() => setSoundOn(sound.enabled), []);
  const [banner, setBanner] = useState<{ amount: string; mult: string; key: number } | null>(null);
  useEffect(() => model.onResult((r: Result) => {
    if (r.outcome === "win") {
      sound.win();
      setBanner({ amount: usd(r.payout), mult: `${(r.tap.multBps / 1e4).toFixed(1)}x`, key: Date.now() });
      setTimeout(() => setBanner((b) => (b && Date.now() - b.key >= 2000 ? null : b)), 2200);
    } else if (r.outcome === "lose") sound.lose();
  }), [model]);

  const [proof, setProof] = useState<Result | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const [toast, setToast] = useState<{ text: string; bad: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = useCallback((text: string, bad = false) => {
    setToast({ text, bad }); clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const firstPrice = useRef<{ symbol: Symbol; p: number } | null>(null);
  const price = model.price === null ? null : Number(model.price) / 1e8;
  if (price !== null && firstPrice.current?.symbol !== symbol) firstPrice.current = { symbol, p: price };
  const change = price !== null && firstPrice.current ? ((price - firstPrice.current.p) / firstPrice.current.p) * 100 : 0;

  const player = model.player;
  const openTaps = player?.taps.filter((t) => t.open).length ?? 0;

  const onTap = useCallback(async (bandIndex: bigint, column: number, zoom: number, multBps: number) => {
    if (account.stage !== "ready" || !signer) return;
    const session = sessionKey(signer.publicKey, false);
    if (!session) return;
    const amount = BigInt(Math.round(stake * 1e6));
    if (!player || player.balance < amount) { say("Not enough balance for that stake", true); return; }
    sound.tap();
    const key = `${column}:${bandIndex}:${Date.now()}`;
    const h = rowHeight(model.market!, zoom), lo = bandIndex * h, hi = lo + h - 1n;
    model.pending.push({ key, lo, hi, column, stake: amount, multBps, at: Date.now() / 1000 });
    try {
      // on-chain window pricing needs ~250k compute units; rollup transactions are free
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: TAP_COMPUTE_UNITS }), ix.placeTap({
        signer: session.publicKey, owner: signer.publicKey, market: model.keys,
        bandIndex, column, zoom, stake: amount, minMultBps: Math.floor(multBps * 0.85),
      }));
      tx.recentBlockhash = await erBlockhash();
      tx.feePayer = session.publicKey;
      tx.sign(session);
      const r = await sendSigned(er, tx, { skipPreflight: true, pollMs: 15 });
      const ms = Math.round(r.ms);
      sound.confirm();
      model.confirms.push({ column, lo, hi, ms, at: Date.now() / 1000 });
      setLatency(ms); setFlash(true); setTimeout(() => setFlash(false), 900);
      model.pushFeed({ id: r.signature, who: "you", me: true, tone: "", text: `${usd(amount)} · ${(multBps / 1e4).toFixed(1)}x` });
    } catch (e) {
      model.pending = model.pending.filter((p) => p.key !== key);
      say(explainError(e), true);
    }
  }, [account.stage, signer, stake, player, model, say]);

  const onReject = useCallback((reason: string, side: "near" | "far") => {
    say(reason === "locked" ? "That column is about to open — tap one further right"
      : reason === "too-far" ? "That column is more than two minutes out"
      : side === "near" ? "Too close to call — no payout offered on that box"
      : "Beyond the house's top multiplier — pick a box closer to the price");
  }, [say]);

  const connectWallet = async (name: string) => {
    try {
      wallet.select(name as Parameters<typeof wallet.select>[0]);
    } catch (e) { say(explainError(e), true); }
  };
  useEffect(() => {
    if (wallet.wallet && !wallet.connected && !wallet.connecting) wallet.connect().catch(() => {});
  }, [wallet]);

  const disconnect = async () => { await wallet.disconnect(); };
  // account errors outside the onboarding card (cash out, add funds) surface as toasts
  useEffect(() => { if (account.error && account.stage === "ready") say(account.error, true); }, [account.error, account.stage, say]);

  const detected = wallet.wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
  const walletNames = detected.map((w) => w.adapter.name);
  const onBlocked = useCallback(() => {
    say(account.stage === "disconnected" ? "Connect a wallet to tap" : "Finish setting up your account to tap");
  }, [account.stage, say]);

  return (
    <main className="app">
      <header className="top">
        <div className="logo"><span className="mark" /><span className="word">Quickdraw</span></div>
        <nav className="mkts" aria-label="Markets">
          {SYMBOLS.map((s) => (
            <button key={s} className="mkt" aria-pressed={s === symbol} onClick={() => setSymbol(s)}>{s}</button>
          ))}
        </nav>
        <div className="right">
          <div className={`badge${flash ? " flash" : ""}`} title="Time from tap to confirmation on the MagicBlock rollup">
            <span className={`pulse${model.erOk ? "" : " off"}`} />
            <span>{latency === null ? "ER · live" : <><span className="hide-sm">tap → ER · </span>{latency}ms</>}</span>
          </div>
          {player && (
            <div className="bal"><span className="lbl">Balance</span><b>{usd(player.balance)}</b></div>
          )}
          <button className="iconbtn" aria-label={soundOn ? "Mute sounds" : "Unmute sounds"} aria-pressed={soundOn}
            onClick={() => { sound.enabled = !soundOn; setSoundOn(!soundOn); }}>
            <SoundIcon on={soundOn} />
          </button>
          <button className="iconbtn" aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            <ThemeIcon dark={theme === "dark"} />
          </button>
          <WalletButton
            signer={signer} busy={account.busy} walletUsdc={account.walletUsdc} canManage={account.stage === "ready"}
            wallets={walletNames} onWallet={connectWallet}
            onDisconnect={disconnect} onCashOut={account.cashOut} onAddFunds={account.addFunds}
          />
        </div>
      </header>

      <section className="hero">
        <div>
          <div className="pair">{symbol} / USD <span className="live">LIVE</span></div>
          <div className="px">{price === null ? "—" : price.toFixed(DECIMALS[symbol])}</div>
        </div>
        <div className="chg" style={{ color: change >= 0 ? "var(--win)" : "var(--loss)" }}>
          {change >= 0 ? "+" : ""}{change.toFixed(3)}%
        </div>
        <p className="hint">Tap a box. If the price touches it before its column closes, you win the multiplier.</p>
      </section>

      <div className="body">
        <div className="boardwrap">
          <Board model={model} stake={stake} canTap={account.stage === "ready"} onTap={onTap} onReject={onReject} onBlocked={onBlocked} />
          {banner && (
            <div className="winbanner" key={banner.key} role="status">
              <span className="lbl">Hit</span><b>+{banner.amount}</b><span className="mono">{banner.mult}</span>
            </div>
          )}
          {account.stage !== "ready" && (
            <Onboarding
              stage={account.stage} busy={account.busy} error={account.error} wallets={walletNames}
              walletUsdc={account.walletUsdc} onWallet={connectWallet} onActivate={account.activate} onRecheck={account.recheck}
            />
          )}
        </div>
        <aside className="side">
          {player && <Positions model={model} onProof={setProof} />}
          <div className="card">
            <div className="card-h"><span>Live taps</span><span>{model.online} trading</span></div>
            {model.feed.length === 0 ? <p className="empty">Waiting for the first tap…</p> : (
              <ul className="list">
                {model.feed.map((f) => (
                  <li key={f.id}><span className={`who${f.me ? " me" : ""}`}>{f.who}</span><span className={`mono ${f.tone}`}>{f.text}</span></li>
                ))}
              </ul>
            )}
          </div>
          <div className="card">
            <div className="card-h"><span>Leaders</span><span>P&amp;L</span></div>
            {model.leaders.length === 0 ? <p className="empty">No trades yet.</p> : (
              <ol className="list">
                {model.leaders.map((l, i) => (
                  <li key={l.owner}>
                    <span className={`who${l.me ? " me" : ""}`}>{i + 1}. {l.me ? "you" : `${l.demo ? "demo·" : ""}${short(l.owner)}`}</span>
                    <span className={`mono ${l.pnl > 0n ? "win" : l.pnl < 0n ? "loss" : ""}`}>{usd(l.pnl)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          {model.book && (
            <div className="card">
              <div className="card-h"><span>House pool</span><span>edge {(model.book.edgeBps / 100).toFixed(0)}%</span></div>
              <ul className="list">
                <li><span className="who">Liquidity</span><span className="mono">{usd(model.book.liquidity)}</span></li>
                <li><span className="who">Open exposure</span><span className="mono">{usd(model.book.exposure)}</span></li>
                <li><span className="who">Volume</span><span className="mono">{usd(model.book.volume)}</span></li>
                <li><span className="who">Taps</span><span className="mono">{model.book.taps.toString()}</span></li>
              </ul>
            </div>
          )}
        </aside>
      </div>

      <footer className="dock">
        <div className="stakes"><span className="lbl">Stake</span>
          {STAKES.map((s) => (
            <button key={s} className="chip" aria-pressed={s === stake} onClick={() => { setStake(s); prefs.setStake(s); }}>${s < 1 ? s.toFixed(2) : s}</button>
          ))}
        </div>
        <div className="stats">
          <div><span className="lbl">Streak</span><b>{player?.streak ?? 0}{(player?.streak ?? 0) >= 3 ? " 🔥" : ""}</b></div>
          <div><span className="lbl">Open</span><b>{openTaps}</b></div>
          <div><span className="lbl">Wins</span><b>{player?.wins ?? 0}</b></div>
          <div>
            <span className="lbl">P&amp;L</span>
            <b style={{ color: (player?.pnl ?? 0n) > 0n ? "var(--win)" : (player?.pnl ?? 0n) < 0n ? "var(--loss)" : undefined }}>
              {player ? `${player.pnl > 0n ? "+" : ""}${usd(player.pnl)}` : "$0.00"}
            </b>
          </div>
        </div>
      </footer>

      {toast && <div className={`toast${toast.bad ? " bad" : ""}`} role="status">{toast.text}</div>}
      {proof && signer && (
        <ProofModal result={proof} symbol={symbol} decimals={DECIMALS[symbol]} owner={signer.publicKey} onClose={() => setProof(null)} />
      )}
    </main>
  );
}

/** Phone browsers have no wallet extension: open this page inside Phantom's in-app browser instead. */
function phantomBrowseLink() {
  if (typeof window === "undefined") return "https://phantom.com/download";
  const url = encodeURIComponent(window.location.href);
  return `https://phantom.app/ul/browse/${url}?ref=${encodeURIComponent(window.location.origin)}`;
}
const isPhone = () => typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** "Connect Phantom" when a wallet is installed, otherwise open-in-Phantom (phones) or install (desktop). */
function ConnectAction({ wallets, onWallet, primary = true }: { wallets: string[]; onWallet: (name: string) => void; primary?: boolean }) {
  const cls = `btn${primary ? " primary" : ""}`;
  const [phone, setPhone] = useState(false);
  useEffect(() => setPhone(isPhone()), []);
  if (wallets.length > 0) {
    return <>{wallets.slice(0, 2).map((w) => <button key={w} className={cls} onClick={() => onWallet(w)}>Connect {w}</button>)}</>;
  }
  return phone
    ? <a className={cls} href={phantomBrowseLink()}>Open in Phantom ↗</a>
    : <a className={cls} href="https://phantom.com/download" target="_blank" rel="noreferrer">Install Phantom ↗</a>;
}

function WalletButton(props: {
  signer: AppSigner | null; busy: string | null; walletUsdc: bigint; canManage: boolean;
  wallets: string[]; onWallet: (name: string) => void;
  onDisconnect: () => void; onCashOut: () => void; onAddFunds: () => void;
}) {
  const { signer, busy, walletUsdc, canManage } = props;
  const [open, setOpen] = useState(false);
  if (!signer) return <div className="connect-top"><ConnectAction wallets={props.wallets} onWallet={props.onWallet} /></div>;
  const act = (fn: () => void) => () => { setOpen(false); fn(); };
  return (
    <div style={{ position: "relative" }}>
      <button className="btn" onClick={() => setOpen(!open)} disabled={!!busy && canManage}>
        <span className="mono nowrap">{busy && canManage ? busy : short(signer.publicKey.toBase58())}</span>
      </button>
      {open && (
        <div className="card menu">
          <p className="lbl">In wallet: {usd(walletUsdc)} USDC</p>
          {canManage && <button className="btn" onClick={act(props.onAddFunds)} disabled={walletUsdc === 0n}>Add wallet USDC</button>}
          {canManage && <button className="btn" onClick={act(props.onCashOut)}>Cash out to wallet</button>}
          <a className="btn" href="https://faucet.circle.com/" target="_blank" rel="noreferrer">Get devnet USDC ↗</a>
          <button className="btn" onClick={act(props.onDisconnect)}>Disconnect</button>
        </div>
      )}
    </div>
  );
}

const STEPS: { stage: Stage[]; text: string }[] = [
  { stage: ["new", "undelegated"], text: "Deposit your devnet USDC into the game" },
  { stage: ["new", "undelegated"], text: "Open your account on the MagicBlock rollup" },
  { stage: ["new", "undelegated", "session"], text: "Authorise this browser to tap without popups for 24h" },
];

function Onboarding(props: {
  stage: Stage; busy: string | null; error: string | null; wallets: string[]; walletUsdc: bigint;
  onWallet: (name: string) => void; onActivate: () => void; onRecheck: () => void;
}) {
  const { stage, busy, error, wallets, walletUsdc } = props;
  const needsUsdc = stage === "new" && walletUsdc === 0n;
  return (
    <div className="overlay">
      <div className="onboard">
        {stage === "disconnected" && (
          <>
            <h2>Fastest tap wins.</h2>
            <p>Tap a box. If the price touches it before its column closes, you win the multiplier — priced and settled on-chain, taps land in ~150ms on a MagicBlock rollup. Plays with devnet USDC.</p>
            <div className="row">
              <ConnectAction wallets={wallets} onWallet={props.onWallet} />
            </div>
          </>
        )}
        {stage === "checking" && <p>Checking your account…</p>}
        {needsUsdc && (
          <>
            <h2>Get devnet USDC</h2>
            <p>Quickdraw plays with Circle&apos;s devnet USDC. Claim 20 free at the faucet: pick <b>USDC</b> and <b>Solana Devnet</b>, paste your wallet address, then come back.</p>
            <div className="row">
              <a className="btn primary" href="https://faucet.circle.com/" target="_blank" rel="noreferrer">Open Circle faucet ↗</a>
              <button className="btn" onClick={props.onRecheck}>I have USDC</button>
            </div>
          </>
        )}
        {!needsUsdc && (stage === "new" || stage === "undelegated" || stage === "session") && (
          <>
            <h2>{stage === "new" ? "One signature to start" : stage === "undelegated" ? "Resume playing" : "Authorise this browser"}</h2>
            {stage !== "session" && <p>{walletUsdc > 0n ? `${usd(walletUsdc)} USDC in your wallet will be deposited.` : "Your game balance moves back into the rollup."}</p>}
            <ul className="steps">
              {STEPS.map((s, i) => (
                <li key={s.text}><span className="n">0{i + 1}</span><span className={s.stage.includes(stage) ? "" : "done"}>{s.text}</span></li>
              ))}
            </ul>
            <button className="btn primary" disabled={!!busy} onClick={props.onActivate}>
              {busy ?? (stage === "new" ? "Deposit and play" : stage === "undelegated" ? "Resume" : "Authorise")}
            </button>
          </>
        )}
        {error && <p className="err">{error}</p>}
      </div>
    </div>
  );
}

function Positions({ model, onProof }: { model: LiveModel; onProof: (r: Result) => void }) {
  const now = Date.now() / 1000 - model.clockOffset;
  const open = (model.player?.taps ?? []).filter((t) => t.open && t.market.equals(model.keys.market)).sort((a, b) => a.end - b.end);
  const recent = [...model.results].reverse().slice(0, 4);
  return (
    <div className="card">
      <div className="card-h"><span>Your taps</span><span>{open.length} open</span></div>
      {open.length === 0 && recent.length === 0 ? <p className="empty">Tap a box on the grid to place one.</p> : (
        <ul className="list">
          {open.map((t) => {
            const live = now >= t.start;
            const secs = Math.max(0, Math.ceil((live ? t.end : t.start) - now));
            return (
              <li key={`o${t.id}`}>
                <span className="who">{(t.multBps / 1e4).toFixed(1)}x · {usd(t.stake)}</span>
                <span className="mono" style={{ color: live ? "var(--accent)" : undefined }}>{live ? `live ${secs}s` : `in ${secs}s`}</span>
              </li>
            );
          })}
          {recent.map((r) => (
            <li key={`r${r.tap.id}-${r.at}`}>
              <button className="proofrow" onClick={() => onProof(r)} title="See how this tap was settled">
                <span className="who">{(r.tap.multBps / 1e4).toFixed(1)}x · {usd(r.tap.stake)}</span>
                <span className={`mono ${r.outcome === "win" ? "win" : r.outcome === "lose" ? "loss" : ""}`}>
                  {r.outcome === "win" ? `+${usd(r.payout)}` : r.outcome === "lose" ? `−${usd(r.tap.stake)}` : "refunded"} <span className="proofhint">proof</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SoundIcon({ on }: { on: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor" stroke="none" />
      {on ? <path d="M11.5 5.5a3.5 3.5 0 0 1 0 5M13 3.5a6 6 0 0 1 0 9" /> : <path d="M11 6l4 4M15 6l-4 4" />}
    </svg>
  );
}

function ThemeIcon({ dark }: { dark: boolean }) {
  return dark ? (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z" fill="currentColor" /></svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="3" fill="currentColor" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" />
    </svg>
  );
}

/** How one settled tap was decided: the box, its window, and the prices the keeper recorded on-chain. */
export function ProofModal({ result, symbol, decimals, owner, onClose }: {
  result: Result; symbol: Symbol; decimals: number; owner: PublicKey; onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const { tap, evidence, outcome } = result;
  const px = (v: bigint) => `$${(Number(v) / 1e8).toFixed(Math.max(decimals, 2))}`;
  const time = (sec: number) => new Date(sec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const bars = evidence?.bars ?? [];
  const lo = Number(tap.lo), hi = Number(tap.hi) + 1;
  const prices = [lo, hi, ...bars.flatMap((b) => [Number(b.low), Number(b.high)])];
  const min = Math.min(...prices), max = Math.max(...prices), pad = (max - min) * 0.15 || 1;
  const W = 380, H = 150, L = 8, R = 8;
  const y = (p: number) => 8 + (1 - (p - (min - pad)) / (max - min + 2 * pad)) * (H - 16);
  const cols = Math.max(1, tap.end - tap.start), cw = (W - L - R) / cols;
  const explorer = `https://explorer.solana.com/address/${playerPda(owner).toBase58()}?cluster=custom&customUrl=${encodeURIComponent(ER_RPC)}`;
  const verdict = outcome === "win"
    ? `The price traded between ${evidence?.low != null ? px(evidence.low) : "?"} and ${evidence?.high != null ? px(evidence.high) : "?"} in this window, which reaches your box, so the house paid ${usd(result.payout)} (${(tap.multBps / 1e4).toFixed(2)}x).`
    : outcome === "lose"
      ? `The price traded between ${evidence?.low != null ? px(evidence.low) : "?"} and ${evidence?.high != null ? px(evidence.high) : "?"} in this window and never reached your box, so the stake stayed with the house.`
      : "No price was recorded for this window, so the stake was refunded.";
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Tap proof" onClick={(e) => e.stopPropagation()}>
        <div className="card-h"><span>Proof · {symbol} tap #{tap.id}</span><button className="iconbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <p className={`verdict ${outcome === "win" ? "win" : outcome === "lose" ? "loss" : ""}`}>
          {outcome === "win" ? "Won" : outcome === "lose" ? "Lost" : "Refunded"} · {usd(tap.stake)} at {(tap.multBps / 1e4).toFixed(2)}x
        </p>
        <svg viewBox={`0 0 ${W} ${H}`} className="proofchart" role="img" aria-label="Your box against the recorded price range">
          <rect x={L} y={y(hi)} width={W - L - R} height={Math.max(2, y(lo) - y(hi))} className="pbox" />
          {bars.map((b) => {
            const x = L + (b.sec - tap.start + 0.5) * cw;
            return <g key={b.sec}>
              <line x1={x} x2={x} y1={y(Number(b.high))} y2={y(Number(b.low))} className="pbar" />
              <line x1={x - 6} x2={x + 6} y1={y(Number(b.high))} y2={y(Number(b.high))} className="pbar" />
              <line x1={x - 6} x2={x + 6} y1={y(Number(b.low))} y2={y(Number(b.low))} className="pbar" />
            </g>;
          })}
        </svg>
        <dl className="proofgrid">
          <dt>Your box</dt><dd>{px(tap.lo)} – {px(tap.hi + 1n)}</dd>
          <dt>Window</dt><dd>{time(tap.start)} – {time(tap.end)}</dd>
          <dt>Recorded range</dt><dd>{evidence?.low != null && evidence.high != null ? `${px(evidence.low)} – ${px(evidence.high)}` : "none"}</dd>
        </dl>
        <p className="prooftext">{verdict}</p>
        <p className="prooftext mute">Rule, enforced by the program: a box wins if the lowest-to-highest price recorded on-chain during its window overlaps the box. Prices move continuously, so every price in that range was traded.</p>
        <div className="row">
          <a className="btn" href={explorer} target="_blank" rel="noreferrer">Your account on the rollup ↗</a>
          <a className="btn" href={`https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`} target="_blank" rel="noreferrer">Program ↗</a>
        </div>
      </div>
    </div>
  );
}
