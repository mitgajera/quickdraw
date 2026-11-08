"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ComputeBudgetProgram, Transaction } from "@solana/web3.js";
import { ER_RPC, PROGRAM_ID, explainError, ix, playerPda, rowHeight, sendSigned, type Symbol } from "@quickdraw/sdk";
import type { PublicKey } from "@solana/web3.js";
import { Board } from "./Board";
import { LogoMark } from "./Logo";
import { HowItWorks } from "./HowItWorks";
import { NEEDS_USDC, useAccount, type Stage } from "@/lib/account";
import { erBlockhash, er, prefs, sessionKey, type AppSigner } from "@/lib/chain";
import { LiveModel, type Result } from "@/lib/live";
import { usePrivySigner } from "@/lib/privy";
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
/** Solana Explorer pointed at the MagicBlock rollup, where taps and settlements live. */
const erExplorer = (path: string) => `https://explorer.solana.com/${path}?cluster=custom&customUrl=${encodeURIComponent(ER_RPC)}`;

export function Game() {
  const auth = usePrivySigner();
  const signer = auth.signer;

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
  const [toast, setToast] = useState<{ text: string; bad: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = useCallback((text: string, bad = false) => {
    setToast({ text, bad }); clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);
  const [banner, setBanner] = useState<{ amount: string; mult: string; big: boolean; key: number } | null>(null);
  useEffect(() => model.onResult((r: Result) => {
    if (r.outcome === "win") {
      sound.win();
      const big = r.tap.multBps >= 100_000;
      if (big && navigator.vibrate) navigator.vibrate([40, 60, 40, 60, 120]);
      setBanner({ amount: usd(r.payout), mult: `${(r.tap.multBps / 1e4).toFixed(1)}x`, big, key: Date.now() });
      setTimeout(() => setBanner((b) => (b && Date.now() - b.key >= 2000 ? null : b)), big ? 3200 : 2200);
    } else if (r.outcome === "lose") {
      sound.lose();
      // a miss by less than one box height deserves a word
      const ev = r.evidence;
      if (ev?.low != null && ev.high != null) {
        const gap = ev.high < r.tap.lo ? r.tap.lo - ev.high : ev.low > r.tap.hi ? ev.low - r.tap.hi : 0n;
        if (gap > 0n && gap <= r.tap.hi - r.tap.lo + 1n) say(`So close — missed by $${(Number(gap) / 1e8).toFixed(Number(gap) < 1e6 ? 4 : 2)}`);
      }
    }
  }), [model, say]);

  const [proof, setProof] = useState<Result | null>(null);
  const [howOpen, setHowOpen] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
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
    if (navigator.vibrate) navigator.vibrate(8);
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
      setLatency(ms); setLastSig(r.signature); setFlash(true); setTimeout(() => setFlash(false), 900);
      model.pushFeed({ id: r.signature, who: "you", me: true, tone: "", text: `${usd(amount)} · ${(multBps / 1e4).toFixed(1)}x` });
    } catch (e) {
      model.pending = model.pending.filter((p) => p.key !== key);
      say(explainError(e), true);
    }
  }, [account.stage, signer, stake, player, model, say]);

  // settle is permissionless: if the keeper has not settled one of our finished taps a couple of
  // seconds after it closed, settle it ourselves (free on the rollup, signed by the session key)
  const settling = useRef(0);
  useEffect(() => {
    if (account.stage !== "ready" || !signer) return;
    const id = setInterval(() => {
      const session = sessionKey(signer.publicKey, false);
      const now = Date.now() / 1000 - model.clockOffset;
      const due = model.player?.taps.some((t) => t.open && t.market.equals(model.keys.market) && now > t.end + 2);
      if (!session || !due || Date.now() - settling.current < 3000) return;
      settling.current = Date.now();
      void (async () => {
        const tx = new Transaction().add(ix.settle(signer.publicKey, model.keys));
        tx.recentBlockhash = await erBlockhash();
        tx.feePayer = session.publicKey;
        tx.sign(session);
        await sendSigned(er, tx, { pollMs: 50 });
      })().catch(() => { /* too early (still pending) or already settled: try again later */ });
    }, 1000);
    return () => clearInterval(id);
  }, [account.stage, signer, model]);

  const onReject = useCallback((reason: string, side: "near" | "far") => {
    say(reason === "locked" ? "That column is about to open — tap one further right"
      : reason === "too-far" ? "That column is more than two minutes out"
      : reason === "limit" ? "Over the house's limit at this stake — lower the stake or pick a lower multiplier"
      : side === "near" ? "Too close to call — no payout offered on that box"
      : "Beyond the house's top multiplier — pick a box closer to the price");
  }, [say]);

  const signIn = () => auth.login();
  const signOut = async () => { await auth.logout(); };

  // the embedded wallet signs silently, so a new account or an expired session sets itself up once per
  // wallet and stage; a failure leaves a retry button on the card. "undelegated" is left to the player:
  // it is where cash out ends, and auto-resuming would deposit the withdrawn USDC straight back
  const attempted = useRef("");
  useEffect(() => {
    const st = account.stage;
    if (!signer || account.busy || !(st === "new" || st === "session")) return;
    const key = `${signer.publicKey.toBase58()}:${st}`;
    if (attempted.current === key) return;
    attempted.current = key;
    void account.activate();
  }, [signer, account.stage, account.busy, account.activate]);
  // account errors outside the onboarding card (cash out, add funds) surface as toasts
  useEffect(() => { if (account.error && account.stage === "ready") say(account.error, true); }, [account.error, account.stage, say]);

  const { login } = auth;
  const onBlocked = useCallback(() => {
    if (account.stage === "disconnected") { say("Sign in to tap"); login(); }
    else if (account.stage === "ready") say("Paused while the game server catches up with prices");
    else say("Setting up your account…");
  }, [account.stage, say, login]);

  return (
    <main className="app">
      <header className="top">
        <div className="logo"><LogoMark /><span className="word">Quickdraw</span></div>
        <nav className="mkts" aria-label="Markets">
          {SYMBOLS.map((s) => (
            <button key={s} className="mkt" aria-pressed={s === symbol} onClick={() => setSymbol(s)}>{s}</button>
          ))}
        </nav>
        <div className="right">
          {(() => {
            const inner = <>
              <span className={`pulse${model.erOk ? "" : " off"}`} />
              <span>{latency === null ? "ER · live" : <><span className="hide-sm">tap → ER · </span>{latency}ms</>}</span>
            </>;
            // after a tap, the badge links to that exact transaction on the rollup's explorer
            return lastSig
              ? <a className={`badge${flash ? " flash" : ""}`} href={erExplorer(`tx/${lastSig}`)} target="_blank" rel="noreferrer"
                  title="Your last tap on the MagicBlock rollup: open it in the explorer">{inner}</a>
              : <div className={`badge${flash ? " flash" : ""}`} title="Time from tap to confirmation on the MagicBlock rollup">{inner}</div>;
          })()}
          {player && (
            <div className="bal"><span className="lbl">Balance</span><b>{usd(player.balance)}</b></div>
          )}
          <button className="iconbtn" aria-label={soundOn ? "Mute sounds" : "Unmute sounds"} aria-pressed={soundOn}
            onClick={() => { sound.enabled = !soundOn; setSoundOn(!soundOn); }}>
            <SoundIcon on={soundOn} />
          </button>
          <button className="iconbtn" aria-label="How it works" title="How it works" onClick={() => setHowOpen(true)}>
            <span className="q">?</span>
          </button>
          <button className="iconbtn theme-toggle" aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            <ThemeIcon dark={theme === "dark"} />
          </button>
          <WalletButton
            signer={signer} name={auth.name} ready={auth.ready} authenticated={auth.authenticated}
            walletError={auth.walletError} onRetryWallet={auth.retryWallet}
            busy={account.busy} walletUsdc={account.walletUsdc} canManage={account.stage === "ready"}
            onSignIn={signIn} onSignOut={signOut} onCashOut={account.cashOut} onAddFunds={account.addFunds}
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
        <div className="hint">
          <p>Tap a box. If the price touches it before its column closes, you win the multiplier.</p>
          {model.book && (
            <p className="statline">
              <b>{model.book.taps.toLocaleString()}</b> taps priced &amp; settled on-chain ·{" "}
              <a href={`https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`} target="_blank" rel="noreferrer">program ↗</a>
            </p>
          )}
        </div>
      </section>

      <div className="body">
        <div className="boardwrap">
          <Board model={model} stake={stake} canTap={account.stage === "ready" && model.recording} onTap={onTap} onReject={onReject} onBlocked={onBlocked} />
          {!model.recording && account.stage === "ready" && (
            <div className="notice" role="status">The game server is catching up with prices — tapping resumes in a few seconds.</div>
          )}
          {banner && (
            <div className={`winbanner${banner.big ? " big" : ""}`} key={banner.key} role="status">
              <span className="lbl">Hit</span><b>+{banner.amount}</b><span className="mono">{banner.mult}</span>
            </div>
          )}
          {account.stage !== "ready" && (
            <Onboarding
              stage={account.stage} busy={account.busy} error={account.error} ready={auth.ready} authenticated={auth.authenticated}
              address={signer?.publicKey.toBase58() ?? null} onSignIn={signIn} onActivate={account.activate}
              walletError={auth.walletError} onRetryWallet={auth.retryWallet} onSignOut={signOut}
              onHow={() => setHowOpen(true)}
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
                {model.book.totalShares > 0n && (
                  <li title="USDC each LP share is worth: started at $1.00, moves with the house's results">
                    <span className="who">LP share value</span>
                    <span className="mono">${(Number(model.book.liquidity) / Number(model.book.totalShares)).toFixed(4)}</span>
                  </li>
                )}
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
      {howOpen && <HowItWorks book={model.book} onClose={() => setHowOpen(false)} />}
      {proof && signer && (
        <ProofModal result={proof} symbol={symbol} decimals={DECIMALS[symbol]} owner={signer.publicKey} onClose={() => setProof(null)} />
      )}
    </main>
  );
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="btn addr" title="Copy your wallet address" onClick={() => {
      void navigator.clipboard?.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
    }}>
      <span className="mono nowrap">{copied ? "Copied" : short(address)}</span>
    </button>
  );
}

function WalletButton(props: {
  signer: AppSigner | null; name: string | null; ready: boolean; authenticated: boolean;
  walletError: string | null; onRetryWallet: () => void;
  busy: string | null; walletUsdc: bigint; canManage: boolean;
  onSignIn: () => void; onSignOut: () => void; onCashOut: () => void; onAddFunds: () => void;
}) {
  const { signer, busy, walletUsdc, canManage } = props;
  const [open, setOpen] = useState(false);
  if (!props.ready) return <div className="connect-top"><button className="btn" disabled>Loading…</button></div>;
  if (!props.authenticated) return <div className="connect-top"><button className="btn primary" onClick={props.onSignIn}>Sign in</button></div>;
  if (!signer) {
    return <div className="connect-top">{props.walletError
      ? <button className="btn" onClick={props.onRetryWallet}>Retry wallet</button>
      : <button className="btn" disabled>Creating wallet…</button>}</div>;
  }
  const act = (fn: () => void) => () => { setOpen(false); fn(); };
  const address = signer.publicKey.toBase58();
  return (
    <div style={{ position: "relative" }}>
      <button className="btn" onClick={() => setOpen(!open)} disabled={!!busy && canManage}>
        <span className="mono nowrap">{busy && canManage ? busy : props.name ?? short(address)}</span>
      </button>
      {open && (
        <div className="card menu">
          <p className="lbl">Your Solana wallet</p>
          <CopyAddress address={address} />
          <p className="lbl">In wallet: {usd(walletUsdc)} USDC</p>
          {canManage && <button className="btn" onClick={act(props.onAddFunds)} disabled={walletUsdc === 0n}>Add wallet USDC</button>}
          {canManage && <button className="btn" onClick={act(props.onCashOut)}>Cash out to wallet</button>}
          <a className="btn" href="https://faucet.circle.com/" target="_blank" rel="noreferrer">Get devnet USDC ↗</a>
          <button className="btn" onClick={act(props.onSignOut)}>Sign out</button>
        </div>
      )}
    </div>
  );
}

function Onboarding(props: {
  stage: Stage; busy: string | null; error: string | null; ready: boolean; authenticated: boolean;
  address: string | null; onSignIn: () => void; onActivate: () => void;
  walletError: string | null; onRetryWallet: () => void; onSignOut: () => void; onHow: () => void;
}) {
  const { stage, busy, error, address } = props;
  const needsUsdc = error === NEEDS_USDC;
  return (
    <div className="overlay">
      <div className="onboard">
        {!props.authenticated && (
          <>
            <h2>Fastest tap wins.</h2>
            <p>
              <span className="hide-sm">Tap a box. If the price touches it before its column closes, you win the multiplier — priced and settled on-chain, taps land in ~150ms on a MagicBlock rollup. Plays with devnet USDC; we cover every fee.</span>
              <span className="show-sm">Tap the box the price will hit before its column closes. Priced on-chain, no fees, no popups.</span>
            </p>
            <div className="row">
              <button className="btn primary" disabled={!props.ready} onClick={props.onSignIn}>{props.ready ? "Sign in with Google or X" : "Loading…"}</button>
              <button className="btn" onClick={props.onHow}>How it works</button>
            </div>
          </>
        )}
        {props.authenticated && !address && !props.walletError && <p>Creating your wallet…</p>}
        {props.authenticated && !address && props.walletError && (
          <>
            <p className="err">{props.walletError}</p>
            <div className="row">
              <button className="btn primary" onClick={props.onRetryWallet}>Try again</button>
              <button className="btn" onClick={props.onSignOut}>Sign out</button>
            </div>
          </>
        )}
        {address && needsUsdc && !busy && (
          <>
            <h2>Add devnet USDC</h2>
            <p>Starter USDC has run out for now. Claim 20 free at Circle&apos;s faucet: pick <b>USDC</b> and <b>Solana Devnet</b>, paste your address, then come back.</p>
            <div className="row">
              <CopyAddress address={address} />
              <a className="btn" href="https://faucet.circle.com/" target="_blank" rel="noreferrer">Open faucet ↗</a>
              <button className="btn primary" onClick={props.onActivate}>I have USDC</button>
            </div>
          </>
        )}
        {address && !needsUsdc && (
          <>
            <h2>{busy ? "Setting you up" : stage === "checking" ? "Checking your account" : "Almost there"}</h2>
            <p>{busy ?? (stage === "checking" ? "One moment…" : "Your account opens on the MagicBlock rollup. No popups, no fees.")}</p>
            {!busy && stage !== "checking" && (
              <div className="row"><button className="btn primary" onClick={props.onActivate}>{error ? "Try again" : "Start playing"}</button></div>
            )}
          </>
        )}
        {error && !needsUsdc && <p className="err">{error}</p>}
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
          {outcome === "win" && (
            <a className="btn primary" target="_blank" rel="noreferrer" href={`https://twitter.com/intent/tweet?${new URLSearchParams({
              text: `Hit ${(tap.multBps / 1e4).toFixed(1)}x on ${symbol} in Quickdraw: +${usd(result.payout)}, priced and settled on-chain on Solana.`,
              url: typeof window === "undefined" ? "" : window.location.origin,
            })}`}>Share on X ↗</a>
          )}
          <a className="btn" href={explorer} target="_blank" rel="noreferrer">Your account on the rollup ↗</a>
          <a className="btn" href={`https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`} target="_blank" rel="noreferrer">Program ↗</a>
        </div>
      </div>
    </div>
  );
}
