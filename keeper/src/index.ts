// Quickdraw keeper: records oracle ticks into each market's candle ring on the ER and settles taps
// the moment the candles decide them. Also tops up new player wallets with a little devnet SOL.
import http from "node:http";
import { ComputeBudgetProgram, Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, type Keypair } from "@solana/web3.js";
import {
  PLAYER_SIZE, PROGRAM_ID, SETTLE_TIMEOUT_SECS, decodeCandles, decodePlayer, explainError, ix, judge,
  marketKeys, parseEvents, sendWithKeypairs, type Candles, type MarketKeys,
} from "@quickdraw/sdk";
import { botKeypairs, config, keeperKeypair } from "./config";
import { startCrowd } from "./crowd";

const keeper: Keypair = keeperKeypair();
const base = new Connection(config.baseRpc, "confirmed");
const er = new Connection(config.erRpc, "confirmed");
const markets: MarketKeys[] = config.markets.map(marketKeys);
const bots = botKeypairs();

const stats = {
  startedAt: new Date().toISOString(),
  ticks: 0, tickErrors: 0, lastTickMs: 0,
  settles: 0, settleErrors: 0, wins: 0, losses: 0, voids: 0,
  players: 0, openTaps: 0, sponsored: 0,
};
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);

// ---------- blockhash cache (ER blockhashes are cheap but not free to fetch every 250ms) ----------
let blockhash = { value: "", at: 0 };
async function erBlockhash() {
  if (Date.now() - blockhash.at > 4_000) blockhash = { value: (await er.getLatestBlockhash()).blockhash, at: Date.now() };
  return blockhash.value;
}

// ---------- ticks ----------
// With a cached blockhash, identical record_tick transactions would share a signature and be
// dropped as duplicates; a rotating compute-unit limit makes every tick's bytes unique.
let nonce = 0;
async function tick(m: MarketKeys, measure: boolean) {
  nonce = (nonce + 1) % 10_000;
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 + nonce }),
    ix.recordTick(m),
  );
  tx.recentBlockhash = await erBlockhash();
  tx.feePayer = keeper.publicKey;
  tx.sign(keeper);
  const t0 = performance.now();
  const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  stats.ticks++;
  if (measure) {
    for (let i = 0; i < 50; i++) {
      const { value: [st] } = await er.getSignatureStatuses([sig]);
      if (st?.err) { stats.tickErrors++; log("tick failed", m.symbol, JSON.stringify(st.err)); return; }
      if (st?.confirmationStatus) { stats.lastTickMs = Math.round(performance.now() - t0); return; }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

function tickLoop(m: MarketKeys) {
  let n = 0;
  setInterval(() => {
    tick(m, n++ % 20 === 0).catch((e) => { stats.tickErrors++; if (stats.tickErrors % 20 === 1) log("tick error", m.symbol, explainError(e)); });
  }, config.tickMs);
}

// ---------- settlement ----------
const inflight = new Set<string>();

async function settleOnce() {
  const [accounts, candleInfos] = await Promise.all([
    er.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: PLAYER_SIZE }] }),
    er.getMultipleAccountsInfo(markets.map((m) => m.candles)),
  ]);
  const candles = new Map<string, Candles>();
  markets.forEach((m, i) => { const info = candleInfos[i]; if (info) candles.set(m.market.toBase58(), decodeCandles(info.data)); });
  const now = Math.floor(Date.now() / 1000);
  let open = 0;
  for (const { account } of accounts) {
    const p = decodePlayer(account.data);
    for (const m of markets) {
      const c = candles.get(m.market.toBase58());
      const taps = p.taps.filter((t) => t.open && t.market.equals(m.market));
      open += taps.length;
      if (!c || taps.length === 0) continue;
      const ready = taps.some((t) => {
        const dataNow = now >= t.end + SETTLE_TIMEOUT_SECS ? Math.max(c.lastPublishTime, t.end) : c.lastPublishTime;
        return judge(c, t.lo, t.hi, t.start, t.end, dataNow) !== "pending";
      });
      const key = `${p.owner.toBase58()}:${m.symbol}`;
      if (ready && !inflight.has(key)) void settle(p.owner, m, key);
    }
  }
  stats.players = accounts.length;
  stats.openTaps = open;
}

async function settle(owner: PublicKey, m: MarketKeys, key: string) {
  inflight.add(key);
  try {
    const r = await sendWithKeypairs(er, [ix.settle(owner, m)], [keeper], { withLogs: true, skipPreflight: true });
    stats.settles++;
    for (const ev of parseEvents(r.logs)) {
      if (ev.kind !== "TapSettled") continue;
      if (ev.outcome === "win") stats.wins++; else if (ev.outcome === "lose") stats.losses++; else stats.voids++;
      log(`settled ${m.symbol} ${owner.toBase58().slice(0, 6)} #${ev.id} ${ev.outcome} paid ${Number(ev.payout) / 1e6} (${r.ms.toFixed(0)}ms)`);
    }
  } catch (e) {
    stats.settleErrors++;
    log("settle error", m.symbol, owner.toBase58().slice(0, 6), explainError(e));
  } finally {
    inflight.delete(key);
  }
}

function settleLoop() {
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    settleOnce().catch((e) => log("scan error", explainError(e))).finally(() => { busy = false; });
  }, config.settleMs);
}

// ---------- devnet SOL top-ups for new player wallets ----------
const sponsored = new Set<string>();

async function sponsor(target: PublicKey) {
  const key = target.toBase58();
  if (sponsored.has(key)) return { ok: false, reason: "already sponsored" };
  const balance = await base.getBalance(target);
  if (balance >= config.sponsorLamports / 2) return { ok: true, reason: "has enough SOL", lamports: balance };
  sponsored.add(key);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: target, lamports: config.sponsorLamports }));
  const r = await sendWithKeypairs(base, tx.instructions, [keeper], { pollMs: 400 });
  stats.sponsored++;
  log(`sponsored ${key.slice(0, 6)} with ${config.sponsorLamports / LAMPORTS_PER_SOL} SOL`);
  return { ok: true, signature: r.signature };
}

function serve() {
  http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Content-Type", "application/json");
    if (req.method === "OPTIONS") { res.end(); return; }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health") { res.end(JSON.stringify({ ...stats, markets: config.markets, bots: bots.length })); return; }
      // demo crowd wallets, so the app can label them honestly
      if (url.pathname === "/bots") { res.end(JSON.stringify(bots.map((b) => b.publicKey.toBase58()))); return; }
      if (url.pathname === "/sponsor" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 512) break; }
        const { wallet } = JSON.parse(body) as { wallet?: string };
        res.end(JSON.stringify(await sponsor(new PublicKey(wallet ?? ""))));
        return;
      }
      res.statusCode = 404; res.end(JSON.stringify({ error: "not found" }));
    } catch (e) {
      res.statusCode = 400; res.end(JSON.stringify({ error: explainError(e) }));
    }
  }).listen(config.port, () => log(`http on :${config.port} (/health, POST /sponsor)`));
}

// ---------- start ----------
log(`keeper ${keeper.publicKey.toBase58()} markets ${config.markets.join(",")} er ${config.erRpc}`);
for (const m of markets) {
  const info = await er.getAccountInfo(m.candles);
  if (!info) { log(`!! ${m.symbol} candles not on the ER — run setup first`); continue; }
  log(`${m.symbol} candles ${m.candles.toBase58()} (${decodeCandles(info.data).ticks} ticks so far)`);
  tickLoop(m);
}
settleLoop();
serve();
if (bots.length) startCrowd(er, bots, markets, log);
setInterval(() => log(`ticks ${stats.ticks} (last ${stats.lastTickMs}ms, ${stats.tickErrors} err) settles ${stats.settles} W/L/V ${stats.wins}/${stats.losses}/${stats.voids} players ${stats.players} open ${stats.openTaps}`), 30_000);
