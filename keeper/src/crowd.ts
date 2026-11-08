// House players: house-run wallets that tap now and then, so a visitor always sees a live market. They
// play by the same rules as everyone (wallet play, same pricing, same settlement); /bots lists their
// addresses publicly. When a wallet runs low the keeper tops it up from its own USDC, so they keep going.
import { ComputeBudgetProgram, Transaction, type Connection, type Keypair } from "@solana/web3.js";
import {
  ataOf, boxAt, decodeBook, decodeCandles, decodeMarket, decodeOracle, bookPda, explainError,
  idealZoom, ix, quoteBox, rowHeight, sendWithKeypairs, sigmaFor, transferTokens, type MarketKeys,
} from "@quickdraw/sdk";

const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

/** Market weights: SOL is the headline market. */
const WEIGHTS: Record<string, number> = { SOL: 0.6, BTC: 0.2, ETH: 0.2 };
/** Small stakes, mostly $0.10, so the house's edge drains them slowly. */
const STAKES = [100_000n, 100_000n, 100_000n, 250_000n];
/** Top up a wallet below LOW with REFILL, at most once per REFILL_EVERY_MS, keeping KEEPER_RESERVE for welcomes. */
const LOW = 300_000n, REFILL = 2_000_000n, REFILL_EVERY_MS = 10 * 60_000, KEEPER_RESERVE = 5_000_000n;

function chooseMarket(markets: MarketKeys[]): MarketKeys {
  const total = markets.reduce((s, m) => s + (WEIGHTS[m.symbol] ?? 0.1), 0);
  let r = Math.random() * total;
  for (const m of markets) { r -= WEIGHTS[m.symbol] ?? 0.1; if (r <= 0) return m; }
  return markets[0]!;
}

const usdcOf = (base: Connection, who: Keypair["publicKey"]) =>
  base.getTokenAccountBalance(ataOf(who)).then((r) => BigInt(r.value.amount)).catch(() => 0n);

async function tapOnce(er: Connection, bot: Keypair, markets: MarketKeys[], wallet: bigint): Promise<string> {
  const stakes = STAKES.filter((s) => s <= wallet);
  if (stakes.length === 0) return "wallet empty";
  const stake = stakes[Math.floor(Math.random() * stakes.length)]!;

  const m = chooseMarket(markets);
  const [mi, bi, ci, oi] = await er.getMultipleAccountsInfo([m.market, bookPda(), m.candles, m.oracle]);
  if (!mi || !bi || !ci || !oi) return `${m.symbol} accounts missing`;
  const market = decodeMarket(mi.data), book = decodeBook(bi.data), candles = decodeCandles(ci.data), o = decodeOracle(oi.data);
  const sigma = sigmaFor(market, candles, o.publishTime);
  const zoom = idealZoom(market, book, o.price, o.publishTime, sigma);
  const row = o.price / rowHeight(market, zoom);
  const colNow = Math.floor(o.publishTime / market.colSecs);
  // mostly the safer boxes near the price, now and then a long shot, like a person would
  const [lo, hi] = Math.random() < 0.15 ? [40_000, 120_000] : [13_000, 40_000];

  for (let attempt = 0; attempt < 16; attempt++) {
    const column = colNow + 2 + Math.floor(Math.random() * 3);
    const bandIndex = row + BigInt(Math.round(between(-3.5, 3.5)));
    const q = quoteBox(book, boxAt(market, bandIndex, column, zoom), o.price, o.publishTime, sigma, stake);
    if (!q.ok || q.multBps < lo || q.multBps > hi) continue;
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
      ix.placeWalletTap({
        signer: bot.publicKey, owner: bot.publicKey, market: m, bandIndex, column, zoom, stake,
        minMultBps: Math.floor(q.multBps * 0.85), quotedMultBps: q.multBps,
      }),
    );
    tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
    tx.feePayer = bot.publicKey;
    tx.sign(bot);
    await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    return `tapped ${m.symbol} $${Number(stake) / 1e6} at ${(q.multBps / 1e4).toFixed(1)}x`;
  }
  return `${m.symbol}: no box in range this time`;
}

/** Starts one independent loop per house wallet, each tapping every 25-75 seconds. */
export function startCrowd(
  base: Connection, er: Connection, bots: Keypair[], markets: MarketKeys[], keeper: Keypair,
  log: (...a: unknown[]) => void,
) {
  for (const bot of bots) {
    const name = `house·${bot.publicKey.toBase58().slice(0, 4)}`;
    let lastNote = "", lastRefill = 0;
    const loop = async () => {
      try {
        let wallet = await usdcOf(base, bot.publicKey);
        if (wallet < LOW && Date.now() - lastRefill > REFILL_EVERY_MS && (await usdcOf(base, keeper.publicKey)) >= REFILL + KEEPER_RESERVE) {
          lastRefill = Date.now();
          await sendWithKeypairs(base, [transferTokens(keeper.publicKey, bot.publicKey, REFILL)], [keeper], { pollMs: 500 });
          wallet += REFILL;
          log(`${name} topped up with $${Number(REFILL) / 1e6}`);
        }
        const note = await tapOnce(er, bot, markets, wallet);
        // log taps, but only log a repeated problem once
        if (note.startsWith("tapped") || note !== lastNote) log(`${name} ${note}`);
        lastNote = note;
      } catch (e) {
        log(`${name} tap failed: ${explainError(e)}`);
      }
      setTimeout(() => void loop(), between(25_000, 75_000));
    };
    setTimeout(() => void loop(), between(3_000, 20_000));
  }
  log(`house players: ${bots.length} wallet(s) ${bots.map((b) => b.publicKey.toBase58().slice(0, 4)).join(", ")}`);
}
