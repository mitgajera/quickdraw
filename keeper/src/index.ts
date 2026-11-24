// Quickdraw keeper: records oracle ticks into each market's candle ring on the ER and settles taps
// the moment the candles decide them. Also welcomes new player wallets with devnet SOL for fees and a
// little starter USDC, so a player who signs in with Google or X can tap straight away.
import http from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { ComputeBudgetProgram, Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, type Keypair } from "@solana/web3.js";
import {
  PLAYER_SIZE, PROGRAM_ID, WALLET_TAP_FLAG, actionEscrowPda, ataOf, createAtaIdempotent, decodeCandles, decodePlayer, explainError, ix,
  ROUND_SECS, decodeLucky, luckyPda, luckySeed, marketKeys, parseEvents, playerPda, sendWithKeypairs, transferTokens,
  type MarketKeys,
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
  players: 0, openTaps: 0, sponsored: 0, welcomed: 0, welcomeUsdc: 0, rounds: 0,
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

// Bandwidth matters (free hosts meter it): instead of downloading every player and every candle ring
// each scan, ask only for players with an open tap. A player account is an 8-byte discriminator, a
// 112-byte header and 12 tap slots of 81 bytes whose last byte is the `open` flag, so one memcmp per
// slot finds them. All 12 queries go in a single JSON-RPC batch; with nothing open the reply is tiny.
const TAP_SLOTS = 12, TAP_OPEN_OFFSET = (slot: number) => 8 + 112 + 81 * slot + 80;

async function openPlayers(): Promise<Buffer[]> {
  const body = Array.from({ length: TAP_SLOTS }, (_, slot) => ({
    jsonrpc: "2.0", id: slot, method: "getProgramAccounts",
    params: [PROGRAM_ID.toBase58(), {
      encoding: "base64", commitment: "confirmed",
      filters: [{ dataSize: PLAYER_SIZE }, { memcmp: { offset: TAP_OPEN_OFFSET(slot), bytes: "2" } }], // "2" = byte 1
    }],
  }));
  const res = await fetch(config.erRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const replies = (await res.json()) as { result?: { pubkey: string; account: { data: [string, string] } }[]; error?: { message: string } }[];
  const seen = new Map<string, Buffer>();
  for (const r of replies) {
    if (r.error) throw new Error(r.error.message);
    for (const a of r.result ?? []) if (!seen.has(a.pubkey)) seen.set(a.pubkey, Buffer.from(a.account.data[0], "base64"));
  }
  return [...seen.values()];
}

/**
 * Settles every open tap whose window has closed. The program judges each tap from the candle ring
 * itself, so the keeper no longer needs to download the rings: it just calls settle once a window is
 * over (players' own browsers still settle their wins the moment the price touches).
 */
async function settleOnce() {
  const players = await openPlayers();
  const now = Math.floor(Date.now() / 1000);
  let open = 0;
  for (const data of players) {
    const p = decodePlayer(data);
    for (const m of markets) {
      const taps = p.taps.filter((t) => t.open && t.market.equals(m.market));
      open += taps.length;
      // wallet taps (paid from the wallet) and balance taps settle through different instructions
      for (const wallet of [false, true]) {
        if (!taps.some((t) => ((t.id & WALLET_TAP_FLAG) !== 0) === wallet && now >= t.end + 1)) continue;
        const key = `${p.owner.toBase58()}:${m.symbol}:${wallet ? "w" : "b"}`;
        if (!inflight.has(key) && (backoff.get(key) ?? 0) < Date.now()) void settle(p.owner, m, key, wallet);
      }
    }
  }
  stats.openTaps = open;
}

/** Player count for /health, from a cheap keys-only scan every few minutes. */
async function countPlayers() {
  const keys = await er.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: PLAYER_SIZE }], dataSlice: { offset: 0, length: 0 } });
  stats.players = keys.length;
}

/** Wallet wins wait for their stake to be collected on Solana: retry those gently. */
const backoff = new Map<string, number>();

async function settle(owner: PublicKey, m: MarketKeys, key: string, wallet: boolean) {
  inflight.add(key);
  try {
    const ixs = wallet
      // settle_wallet also schedules the Magic Action that pays the wallet on Solana
      ? [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix.settleWallet(keeper.publicKey, owner, m)]
      : [ix.settle(owner, m)];
    const r = await sendWithKeypairs(er, ixs, [keeper], { withLogs: true, skipPreflight: !wallet });
    stats.settles++;
    for (const ev of parseEvents(r.logs)) {
      if (ev.kind !== "TapSettled") continue;
      if (ev.outcome === "win") stats.wins++; else if (ev.outcome === "lose") stats.losses++; else stats.voids++;
      log(`settled ${m.symbol} ${owner.toBase58().slice(0, 6)} #${ev.id} ${ev.outcome} paid ${Number(ev.payout) / 1e6} (${r.ms.toFixed(0)}ms)`);
    }
  } catch (e) {
    const msg = explainError(e);
    // retry later either way; "not settled yet" (stake still on its way, or the price record has not
    // reached the window's end) is expected and not an error
    backoff.set(key, Date.now() + 3000);
    if (!/settled yet|nothing to settle|pending/i.test(msg)) {
      stats.settleErrors++;
      log("settle error", m.symbol, owner.toBase58().slice(0, 6), msg);
    }
  } finally {
    inflight.delete(key);
  }
}

// ---------- golden columns: ask MagicBlock VRF for each round's seed (free on the rollup) ----------
async function drawRounds() {
  const info = await er.getAccountInfo(luckyPda());
  if (!info) return; // golden columns not set up on this deployment
  const lucky = decodeLucky(info.data);
  const now = Math.floor(Date.now() / 1000 / ROUND_SECS);
  for (const round of [now, now + 1]) {
    if (luckySeed(lucky, round)) continue;
    await sendWithKeypairs(er, [ix.requestLucky(keeper.publicKey, round)], [keeper], { skipPreflight: true });
    stats.rounds++;
  }
}

function luckyLoop() {
  let quiet = 0;
  const run = () => void drawRounds().catch((e) => { if (quiet++ % 20 === 0) log("vrf request failed", explainError(e)); });
  run();
  setInterval(run, 20_000);
}

// ---------- the escrow that pays for Magic Actions on Solana ----------
async function fundEscrow() {
  const lamports = await base.getBalance(actionEscrowPda());
  if (lamports >= config.escrowMinLamports) return;
  await sendWithKeypairs(base, [ix.topUpActionEscrow(keeper.publicKey, BigInt(config.escrowTopUpLamports))], [keeper], { pollMs: 400 });
  log(`topped up the action escrow to ${(lamports + config.escrowTopUpLamports) / LAMPORTS_PER_SOL} SOL`);
}

function settleLoop() {
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    settleOnce().catch((e) => log("scan error", explainError(e))).finally(() => { busy = false; });
  }, config.settleMs);
}

// ---------- welcome grants for new player wallets ----------
// Devnet SOL for base-layer fees and rent, plus a little starter USDC from the keeper's own wallet.
// Only for players signed in with Privy (the access token is verified against Privy's public keys),
// once per wallet and per Privy user, rate-limited per IP, and only while the SOL and USDC budgets
// last. A wallet that already has a game account or its own USDC gets the SOL top-up only.
const welcomed = new Set<string>();
const welcomedUsers = new Set<string>();
const ipHits = new Map<string, number[]>();
let welcomeSpent = 0n;
let solSpent = 0;
const privyKeys = config.privyAppId
  ? createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${config.privyAppId}/jwks.json`))
  : null;

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** The Privy user id behind a request's bearer token, or null when auth is switched off. */
async function privyUser(req: http.IncomingMessage): Promise<string | null> {
  if (!privyKeys) return null;
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "sign in first");
  try {
    const { payload } = await jwtVerify(token, privyKeys, { issuer: "privy.io", audience: config.privyAppId });
    if (!payload.sub) throw new Error("no subject");
    return payload.sub;
  } catch {
    throw new HttpError(401, "your sign-in expired, sign in again");
  }
}

function rateLimit(req: http.IncomingMessage) {
  const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0] ?? req.socket.remoteAddress ?? "?").trim();
  const now = Date.now();
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (hits.length >= config.welcomePerIpHour) throw new HttpError(429, "too many new wallets from here, try again later");
  hits.push(now);
  ipHits.set(ip, hits);
}

async function welcome(target: PublicKey, user: string | null) {
  const key = target.toBase58();
  if (welcomed.has(key) || (user && welcomedUsers.has(user))) return { ok: true, reason: "already welcomed", usdc: 0 };
  welcomed.add(key);
  if (user) welcomedUsers.add(user);
  try {
    const [lamports, player, usdc, keeperUsdc] = await Promise.all([
      base.getBalance(target),
      base.getAccountInfo(playerPda(target)),
      base.getTokenAccountBalance(ataOf(target)).then((r) => BigInt(r.value.amount)).catch(() => 0n),
      base.getTokenAccountBalance(ataOf(keeper.publicKey)).then((r) => BigInt(r.value.amount)).catch(() => 0n),
    ]);
    const ixs = [];
    const needsSol = lamports < config.sponsorLamports / 2;
    if (needsSol && solSpent + config.sponsorLamports > config.solBudget) throw new HttpError(503, "the fee budget is used up for now");
    if (needsSol) {
      ixs.push(SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: target, lamports: config.sponsorLamports }));
    }
    const grant = !player && usdc === 0n && welcomeSpent + config.welcomeUsdc <= config.welcomeBudget && keeperUsdc >= config.welcomeUsdc
      ? config.welcomeUsdc : 0n;
    if (grant > 0n) ixs.push(createAtaIdempotent(keeper.publicKey, target), transferTokens(keeper.publicKey, target, grant));
    if (!ixs.length) return { ok: true, reason: "nothing to send", usdc: 0 };
    if (grant > 0n) welcomeSpent += grant;
    if (needsSol) solSpent += config.sponsorLamports;
    const r = await sendWithKeypairs(base, ixs, [keeper], { pollMs: 400 }).catch((e) => {
      welcomeSpent -= grant;
      if (needsSol) solSpent -= config.sponsorLamports;
      throw e;
    });
    if (lamports < config.sponsorLamports / 2) stats.sponsored++;
    if (grant > 0n) { stats.welcomed++; stats.welcomeUsdc = Number(welcomeSpent) / 1e6; }
    log(`welcomed ${key.slice(0, 6)}: ${lamports < config.sponsorLamports / 2 ? `${config.sponsorLamports / LAMPORTS_PER_SOL} SOL` : "no SOL"}, ${Number(grant) / 1e6} USDC`);
    return { ok: true, signature: r.signature, usdc: Number(grant) / 1e6 };
  } catch (e) {
    welcomed.delete(key);
    if (user) welcomedUsers.delete(user);
    throw e;
  }
}

async function readWallet(req: http.IncomingMessage) {
  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > 512) break; }
  return new PublicKey((JSON.parse(body) as { wallet?: string }).wallet ?? "");
}

function serve() {
  http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
    res.setHeader("Content-Type", "application/json");
    if (req.method === "OPTIONS") { res.end(); return; }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health") { res.end(JSON.stringify({ ...stats, markets: config.markets, bots: bots.length })); return; }
      // house player wallets, listed publicly so anyone can tell them apart
      if (url.pathname === "/bots") { res.end(JSON.stringify(bots.map((b) => b.publicKey.toBase58()))); return; }
      // "/sponsor" is the old name, kept for app builds that still call it
      if ((url.pathname === "/welcome" || url.pathname === "/sponsor") && req.method === "POST") {
        const user = await privyUser(req);
        rateLimit(req);
        res.end(JSON.stringify(await welcome(await readWallet(req), user)));
        return;
      }
      res.statusCode = 404; res.end(JSON.stringify({ error: "not found" }));
    } catch (e) {
      res.statusCode = e instanceof HttpError ? e.status : 400;
      res.end(JSON.stringify({ error: e instanceof HttpError ? e.message : explainError(e) }));
    }
  }).listen(config.port, () => log(`http on :${config.port} (/health, /bots, POST /welcome)`));
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
luckyLoop();
void countPlayers().catch(() => {});
setInterval(() => void countPlayers().catch(() => {}), 5 * 60_000);
serve();
void fundEscrow().catch((e) => log("escrow top-up failed", explainError(e)));
setInterval(() => void fundEscrow().catch((e) => log("escrow top-up failed", explainError(e))), 5 * 60_000);
if (bots.length) startCrowd(base, er, bots, markets, keeper, log);
setInterval(() => log(`ticks ${stats.ticks} (last ${stats.lastTickMs}ms, ${stats.tickErrors} err) settles ${stats.settles} W/L/V ${stats.wins}/${stats.losses}/${stats.voids} players ${stats.players} open ${stats.openTaps}`), 30_000);
