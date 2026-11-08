// Live market model: polls the ER for the oracle, candles, book, the player and everyone else's
// taps. The canvas reads the mutable model every frame; React re-renders from `version` bumps.
import type { PublicKey } from "@solana/web3.js";
import {
  CANDLE_SLOTS, PLAYER_SIZE, PROGRAM_ID, bookPda, decodeBook, decodeCandles, decodeMarket, decodeOracle,
  decodePlayer, idealZoom, judge, marketKeys, payoutOf, playerPda, rangeAt, sigmaFor, windowRange,
  type Book, type Candles, type Market, type MarketKeys, type Player, type Symbol, type TapSlot,
} from "@quickdraw/sdk";
import { KEEPER_URL, base, er } from "./chain";

export interface PricePoint { t: number; p: number }
/** The on-chain price evidence for one settled tap: per-second high/low the keeper recorded in its window. */
export interface Evidence { low: bigint | null; high: bigint | null; bars: { sec: number; high: bigint; low: bigint }[] }
export interface Result { tap: TapSlot; outcome: "win" | "lose" | "void"; at: number; payout: bigint; evidence: Evidence | null }
export interface Pending { key: string; lo: bigint; hi: bigint; column: number; stake: bigint; multBps: number; at: number }
export interface FeedItem { id: string; who: string; me: boolean; text: string; tone: "win" | "loss" | "" }
export interface Leader { owner: string; pnl: bigint; wins: number; taps: number; me: boolean; demo: boolean }

/** Captures the candle ring's record of a tap's window at the moment it settles (the ring wraps after 256s). */
function evidenceFor(c: Candles, t: TapSlot): Evidence {
  const bars: Evidence["bars"] = [];
  for (let sec = t.start; sec < t.end; sec++) {
    const r = rangeAt(c, sec);
    if (r) bars.push({ sec, high: r[0], low: r[1] });
  }
  const range = windowRange(c, t.start, t.end);
  return { low: range?.[0] ?? null, high: range?.[1] ?? null, bars };
}

type Outcome = "win" | "lose" | "void";
const pnlOf = (t: TapSlot, o: Outcome) => (o === "win" ? payoutOf(t) - t.stake : o === "lose" ? -t.stake : 0n);

/**
 * The outcome of each settled tap, matched to the change in the player's win count and P&L (which the
 * program updates on every settlement). Our candle-based guess is the tie-breaker when several taps
 * settle in one poll and more than one assignment fits.
 */
function settledOutcomes(taps: TapSlot[], dWins: number, dPnl: bigint, guess: (t: TapSlot) => string): Outcome[] {
  const guesses = taps.map((t) => { const g = guess(t); return (g === "pending" ? "win" : g) as Outcome; });
  if (taps.length > 6) return guesses;
  const all: Outcome[] = ["win", "lose", "void"];
  let best: Outcome[] | null = null, bestScore = -1;
  const pick: Outcome[] = [];
  const walk = (i: number, wins: number, pnl: bigint) => {
    if (i === taps.length) {
      if (wins !== dWins || pnl !== dPnl) return;
      const score = pick.filter((o, k) => o === guesses[k]).length;
      if (score > bestScore) { bestScore = score; best = [...pick]; }
      return;
    }
    for (const o of all) {
      pick.push(o);
      walk(i + 1, wins + (o === "win" ? 1 : 0), pnl + pnlOf(taps[i]!, o));
      pick.pop();
    }
  };
  walk(0, 0, 0n);
  return best ?? guesses;
}

const short = (k: PublicKey | string) => { const s = typeof k === "string" ? k : k.toBase58(); return `${s.slice(0, 4)}…${s.slice(-3)}`; };
const usd = (v: bigint) => `$${(Number(v) / 1e6).toFixed(2)}`;
const mult = (bps: number) => `${(bps / 1e4).toFixed(bps >= 100_000 ? 0 : 1)}x`;

export class LiveModel {
  keys: MarketKeys;
  market: Market | null = null;
  book: Book | null = null;
  candles: Candles | null = null;
  price: bigint | null = null;
  publishTime = 0;
  hist: PricePoint[] = [];
  /** local clock minus oracle clock, so price points can be placed on the grid's time axis */
  clockOffset = 0;
  player: Player | null = null;
  others: { owner: PublicKey; taps: TapSlot[] }[] = [];
  leaders: Leader[] = [];
  feed: FeedItem[] = [];
  results: Result[] = [];
  pending: Pending[] = [];
  /** "✓ 52ms" chips drawn over freshly confirmed taps */
  confirms: { column: number; lo: bigint; hi: bigint; ms: number; at: number }[] = [];
  /** Grid zoom (rows are `market.band << zoom`), chosen from live volatility with hysteresis. */
  zoom = 0;
  private zoomVotes = 0;
  online = 0;
  erOk = true;
  version = 0;
  private resultListeners = new Set<(r: Result) => void>();

  private owner: PublicKey | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private seenOthers = new Map<string, Map<number, TapSlot>>();
  private offsets: number[] = [];
  private listeners = new Set<() => void>();
  private stopped = false;

  constructor(symbol: Symbol) { this.keys = marketKeys(symbol); }

  /** Called once per own tap the keeper settles. */
  onResult(fn: (r: Result) => void) { this.resultListeners.add(fn); return () => { this.resultListeners.delete(fn); }; }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private bump() { this.version++; this.listeners.forEach((f) => f()); }

  setOwner(owner: PublicKey | null) {
    this.owner = owner;
    this.player = null;
    this.results = [];
    this.pending = [];
    void this.fast();
  }

  /** House-run demo wallets (from the keeper), labelled so nobody mistakes them for players. */
  demo = new Set<string>();
  name(owner: PublicKey) { return `${this.demo.has(owner.toBase58()) ? "demo·" : ""}${short(owner)}`; }

  start() {
    void fetch(`${KEEPER_URL}/bots`).then((r) => r.json() as Promise<string[]>).then((list) => { this.demo = new Set(list); }).catch(() => {});
    // React dev mode mounts twice (start, stop, start): reset rather than stay stopped
    this.stopped = false;
    this.timers.forEach(clearInterval);
    this.timers = [];
    void this.loadMarket();
    void this.slow();
    void this.everyone();
    this.timers.push(setInterval(() => void this.fast(), 250));
    this.timers.push(setInterval(() => void this.slow(), 1000));
    this.timers.push(setInterval(() => void this.everyone(), 2000));
    this.timers.push(setInterval(() => this.bump(), 500));
  }

  stop() { this.stopped = true; this.timers.forEach(clearInterval); this.timers = []; }

  /**
   * Whether the keeper is recording prices: its candle ring keeps up with the oracle. When it falls
   * behind (the server is asleep or restarting) taps could not be judged, so the app pauses tapping.
   */
  get recording(): boolean {
    if (!this.candles || this.publishTime === 0) return true;
    return this.publishTime - this.candles.lastPublishTime <= 6;
  }

  private async loadMarket() {
    const info = await base.getAccountInfo(this.keys.market).catch(() => null);
    if (info) { this.market = decodeMarket(info.data); this.bump(); }
  }

  /** oracle + own player, 4x a second */
  private async fast() {
    if (this.stopped) return;
    const keys = [this.keys.oracle, ...(this.owner ? [playerPda(this.owner)] : [])];
    try {
      const [oracle, player] = await er.getMultipleAccountsInfo(keys);
      this.erOk = true;
      if (oracle) this.ingestPrice(decodeOracle(oracle.data));
      if (this.owner) this.ingestPlayer(player ? decodePlayer(player.data) : null);
    } catch {
      this.erOk = false;
    }
  }

  private ingestPrice({ price, publishTime }: { price: bigint; publishTime: number }) {
    const now = Date.now() / 1000;
    this.offsets.push(now - publishTime);
    if (this.offsets.length > 40) this.offsets.shift();
    // publish times are whole seconds: the smallest gap is the closest to true latency
    this.clockOffset = Math.min(...this.offsets);
    if (price === this.price && publishTime === this.publishTime) return;
    this.price = price;
    this.publishTime = publishTime;
    this.hist.push({ t: now - this.clockOffset, p: Number(price) / 1e8 });
    while (this.hist.length > 2 && this.hist[0]!.t < now - 120) this.hist.shift();
  }

  private ingestPlayer(next: Player | null) {
    const prev = this.player;
    this.player = next;
    if (!prev || !next) return;
    // taps that were open and are now closed have been settled; the account's own win and P&L
    // counters say exactly how, so the result never depends on how fresh our candle copy is
    const closed = prev.taps.filter((t) => t.open && !next.taps.some((x) => x.open && x.id === t.id));
    if (closed.length) {
      const outcomes = settledOutcomes(closed, next.wins - prev.wins, next.pnl - prev.pnl, (t) =>
        this.candles ? judge(this.candles, t.lo, t.hi, t.start, t.end, Math.max(this.publishTime, t.end)) : "lose");
      const fresh: Result[] = [];
      closed.forEach((t, i) => {
        if (!t.market.equals(this.keys.market)) return;
        const outcome = outcomes[i]!;
        const result: Result = {
          tap: t, at: Date.now() / 1000, outcome,
          payout: outcome === "win" ? payoutOf(t) : outcome === "void" ? t.stake : 0n,
          evidence: this.candles ? evidenceFor(this.candles, t) : null,
        };
        fresh.push(result);
        this.results.push(result);
        this.pushFeed({
          id: `r${t.id}-${result.at}`, who: "you", me: true, tone: outcome === "win" ? "win" : outcome === "lose" ? "loss" : "",
          text: outcome === "win" ? `won ${usd(result.payout)}` : outcome === "lose" ? `lost ${usd(t.stake)}` : `refunded ${usd(t.stake)}`,
        });
        this.resultListeners.forEach((f) => f(result));
      });
      if (fresh.length) void this.refreshEvidence(fresh);
    }
    // drop pending taps the chain now shows
    this.pending = this.pending.filter((p) => !next.taps.some((t) => t.open && t.start === p.column * (this.market?.colSecs ?? 4)
      && t.lo === p.lo));
    const horizon = Date.now() / 1000 - 90;
    this.results = this.results.filter((r) => r.at > horizon);
    this.confirms = this.confirms.filter((c) => c.at > Date.now() / 1000 - 2);
  }

  /** Re-reads the candle ring right after a settlement so each proof shows the final recorded window. */
  private async refreshEvidence(results: Result[]) {
    const info = await er.getAccountInfo(this.keys.candles).catch(() => null);
    if (!info) return;
    this.candles = decodeCandles(info.data);
    for (const r of results) r.evidence = evidenceFor(this.candles, r.tap);
    this.bump();
  }

  /** candles + book, once a second */
  private async slow() {
    if (this.stopped) return;
    try {
      // re-read the market every second too: its grid can be retuned on-chain at any time, and a
      // stale row height would quote boxes the program then rejects
      const [candles, book, market] = await er.getMultipleAccountsInfo([this.keys.candles, bookPda(), this.keys.market]);
      if (candles) {
        this.candles = decodeCandles(candles.data);
        if (this.hist.length < 3) this.backfill(this.candles);
      }
      if (book) this.book = decodeBook(book.data);
      if (market) this.market = decodeMarket(market.data);
      else if (!this.market) await this.loadMarket();
      this.updateZoom();
    } catch { /* next round */ }
  }

  /** Follows the ideal zoom, but only after it has held for 3 seconds so the grid does not flicker. */
  private updateZoom() {
    const { market, book, price, candles, publishTime } = this;
    if (!market || !book || price === null) return;
    const ideal = idealZoom(market, book, price, publishTime, sigmaFor(market, candles, publishTime));
    if (ideal === this.zoom) { this.zoomVotes = 0; return; }
    if (++this.zoomVotes >= 3 || this.hist.length < 10) { this.zoom = ideal; this.zoomVotes = 0; }
  }

  /** Seeds the chart from the on-chain candle ring so it is never empty on load. */
  private backfill(c: Candles) {
    const now = Date.now() / 1000;
    const last = c.lastPublishTime;
    const pts: PricePoint[] = [];
    for (let sec = last - 90; sec <= last; sec++) {
      const i = ((sec % CANDLE_SLOTS) + CANDLE_SLOTS) % CANDLE_SLOTS;
      if (c.secs[i] !== BigInt(sec)) continue;
      pts.push({ t: sec + 0.25, p: Number(c.lows[i]!) / 1e8 }, { t: sec + 0.75, p: Number(c.highs[i]!) / 1e8 });
    }
    if (pts.length) {
      const shift = now - this.clockOffset - (last + 1);
      this.hist = [...pts.map((p) => ({ t: p.t + Math.max(0, shift), p: p.p })), ...this.hist];
    }
  }

  /** every player's open taps and stats, every 2 seconds */
  private async everyone() {
    if (this.stopped) return;
    try {
      const accounts = await er.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: PLAYER_SIZE }] });
      const players = accounts.map((a) => decodePlayer(a.account.data));
      const me = this.owner?.toBase58();
      this.others = players
        .filter((p) => p.owner.toBase58() !== me)
        .map((p) => ({ owner: p.owner, taps: p.taps.filter((t) => t.open && t.market.equals(this.keys.market)) }));
      this.leaders = players
        .filter((p) => p.tapsPlaced > 0)
        .map((p) => ({ owner: p.owner.toBase58(), pnl: p.pnl, wins: p.wins, taps: p.tapsPlaced, me: p.owner.toBase58() === me, demo: this.demo.has(p.owner.toBase58()) }))
        .sort((a, b) => (b.pnl > a.pnl ? 1 : b.pnl < a.pnl ? -1 : 0))
        .slice(0, 8);
      this.online = players.filter((p) => p.taps.some((t) => t.open)).length;
      for (const o of this.others) {
        const k = o.owner.toBase58();
        const seen = this.seenOthers.get(k);
        if (seen) {
          for (const t of o.taps) {
            if (!seen.has(t.id)) {
              this.pushFeed({ id: `${k}-${t.id}`, who: this.name(o.owner), me: false, tone: "", text: `${usd(t.stake)} · ${mult(t.multBps)}` });
            }
          }
          // their taps that closed since last scan: same rule the keeper settled them by
          for (const [id, t] of seen) {
            if (o.taps.some((x) => x.id === id) || !this.candles) continue;
            const outcome = judge(this.candles, t.lo, t.hi, t.start, t.end, Math.max(this.publishTime, t.end));
            if (outcome === "win") this.pushFeed({ id: `${k}-${id}-w`, who: this.name(o.owner), me: false, tone: "win", text: `won ${usd(payoutOf(t))}` });
            else if (outcome === "lose") this.pushFeed({ id: `${k}-${id}-l`, who: this.name(o.owner), me: false, tone: "loss", text: `lost ${usd(t.stake)}` });
          }
        }
        this.seenOthers.set(k, new Map(o.taps.map((t) => [t.id, t])));
      }
    } catch { /* next round */ }
  }

  pushFeed(item: FeedItem) {
    this.feed = [item, ...this.feed.filter((f) => f.id !== item.id)].slice(0, 8);
  }
}
