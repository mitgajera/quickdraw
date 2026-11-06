// Live market model: polls the ER for the oracle, candles, book, the player and everyone else's
// taps. The canvas reads the mutable model every frame; React re-renders from `version` bumps.
import type { PublicKey } from "@solana/web3.js";
import {
  CANDLE_SLOTS, PLAYER_SIZE, PROGRAM_ID, bookPda, decodeBook, decodeCandles, decodeMarket, decodeOracle,
  decodePlayer, judge, marketKeys, payoutOf, playerPda,
  type Book, type Candles, type Market, type MarketKeys, type Player, type Symbol, type TapSlot,
} from "@quickdraw/sdk";
import { base, er } from "./chain";

export interface PricePoint { t: number; p: number }
export interface Result { tap: TapSlot; outcome: "win" | "lose" | "void"; at: number; payout: bigint }
export interface Pending { key: string; bandIndex: bigint; column: number; stake: bigint; multBps: number; at: number }
export interface FeedItem { id: string; who: string; me: boolean; text: string; tone: "win" | "loss" | "" }
export interface Leader { owner: string; pnl: bigint; wins: number; taps: number; me: boolean }

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
  online = 0;
  erOk = true;
  version = 0;
  onResult?: (r: Result) => void;

  private owner: PublicKey | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private seenOthers = new Map<string, Set<number>>();
  private offsets: number[] = [];
  private listeners = new Set<() => void>();
  private stopped = false;

  constructor(symbol: Symbol) { this.keys = marketKeys(symbol); }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private bump() { this.version++; this.listeners.forEach((f) => f()); }

  setOwner(owner: PublicKey | null) {
    this.owner = owner;
    this.player = null;
    this.results = [];
    this.pending = [];
    void this.fast();
  }

  start() {
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
    // taps that were open and are now closed have been settled by the keeper
    for (const t of prev.taps) {
      if (!t.open || !t.market.equals(this.keys.market)) continue;
      const still = next.taps.find((x) => x.open && x.id === t.id);
      if (still) continue;
      const outcome = this.candles ? judge(this.candles, t.lo, t.hi, t.start, t.end, Math.max(this.publishTime, t.end)) : "lose";
      const result: Result = {
        tap: t, at: Date.now() / 1000,
        outcome: outcome === "pending" ? "win" : outcome,
        payout: outcome === "win" || outcome === "pending" ? payoutOf(t) : outcome === "void" ? t.stake : 0n,
      };
      this.results.push(result);
      this.pushFeed({
        id: `r${t.id}-${result.at}`, who: "you", me: true, tone: result.outcome === "win" ? "win" : result.outcome === "lose" ? "loss" : "",
        text: result.outcome === "win" ? `won ${usd(result.payout)}` : result.outcome === "lose" ? `lost ${usd(t.stake)}` : `refunded ${usd(t.stake)}`,
      });
      this.onResult?.(result);
    }
    // drop pending taps the chain now shows
    this.pending = this.pending.filter((p) => !next.taps.some((t) => t.open && t.start === p.column * (this.market?.colSecs ?? 4)
      && t.lo === p.bandIndex * (this.market?.band ?? 0n)));
    const horizon = Date.now() / 1000 - 90;
    this.results = this.results.filter((r) => r.at > horizon);
  }

  /** candles + book, once a second */
  private async slow() {
    if (this.stopped) return;
    try {
      const [candles, book] = await er.getMultipleAccountsInfo([this.keys.candles, bookPda()]);
      if (candles) {
        this.candles = decodeCandles(candles.data);
        if (this.hist.length < 3) this.backfill(this.candles);
      }
      if (book) this.book = decodeBook(book.data);
      if (!this.market) await this.loadMarket();
    } catch { /* next round */ }
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
        .map((p) => ({ owner: p.owner.toBase58(), pnl: p.pnl, wins: p.wins, taps: p.tapsPlaced, me: p.owner.toBase58() === me }))
        .sort((a, b) => (b.pnl > a.pnl ? 1 : b.pnl < a.pnl ? -1 : 0))
        .slice(0, 8);
      this.online = players.filter((p) => p.taps.some((t) => t.open)).length;
      for (const o of this.others) {
        const k = o.owner.toBase58();
        const seen = this.seenOthers.get(k);
        const ids = new Set(o.taps.map((t) => t.id));
        if (seen) {
          for (const t of o.taps) {
            if (!seen.has(t.id)) {
              this.pushFeed({ id: `${k}-${t.id}`, who: short(o.owner), me: false, tone: "", text: `${usd(t.stake)} · ${mult(t.multBps)}` });
            }
          }
        }
        this.seenOthers.set(k, ids);
      }
    } catch { /* next round */ }
  }

  pushFeed(item: FeedItem) {
    this.feed = [item, ...this.feed.filter((f) => f.id !== item.id)].slice(0, 8);
  }
}
