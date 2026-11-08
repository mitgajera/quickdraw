// House players: house-run wallets that tap now and then, so a visitor always sees a live market. They
// play by the same rules as everyone (same pricing, same settlement); /bots lists their addresses publicly.
import { ComputeBudgetProgram, Transaction, type Connection, type Keypair } from "@solana/web3.js";
import {
  boxAt, decodeBook, decodeCandles, decodeMarket, decodeOracle, decodePlayer, bookPda, explainError,
  idealZoom, ix, playerPda, quoteBox, rowHeight, sigmaFor, type MarketKeys,
} from "@quickdraw/sdk";

const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

/** Market weights: SOL is the headline market. */
const WEIGHTS: Record<string, number> = { SOL: 0.6, BTC: 0.2, ETH: 0.2 };

function chooseMarket(markets: MarketKeys[]): MarketKeys {
  const total = markets.reduce((s, m) => s + (WEIGHTS[m.symbol] ?? 0.1), 0);
  let r = Math.random() * total;
  for (const m of markets) { r -= WEIGHTS[m.symbol] ?? 0.1; if (r <= 0) return m; }
  return markets[0]!;
}

async function tapOnce(er: Connection, bot: Keypair, markets: MarketKeys[]): Promise<string> {
  const playerInfo = await er.getAccountInfo(playerPda(bot.publicKey));
  if (!playerInfo) return "not on the rollup (run bots:setup)";
  const balance = decodePlayer(playerInfo.data).balance;
  // small, varied stakes so a few dollars keeps a bot playing for hours
  const stakes = [100_000n, 100_000n, 250_000n, 250_000n, 500_000n].filter((s) => s <= balance);
  if (stakes.length === 0) return "out of balance";
  const stake = stakes[Math.floor(Math.random() * stakes.length)]!;
  if (balance < stake) return "out of balance";

  const m = chooseMarket(markets);
  const [mi, bi, ci, oi] = await er.getMultipleAccountsInfo([m.market, bookPda(), m.candles, m.oracle]);
  if (!mi || !bi || !ci || !oi) return `${m.symbol} accounts missing`;
  const market = decodeMarket(mi.data), book = decodeBook(bi.data), candles = decodeCandles(ci.data), o = decodeOracle(oi.data);
  const sigma = sigmaFor(market, candles, o.publishTime);
  const zoom = idealZoom(market, book, o.price, o.publishTime, sigma);
  const row = o.price / rowHeight(market, zoom);
  const colNow = Math.floor(o.publishTime / market.colSecs);

  // try a few random nearby boxes; keep ones a person would plausibly tap (1.5x - 12x)
  for (let attempt = 0; attempt < 12; attempt++) {
    const column = colNow + 2 + Math.floor(Math.random() * 3);
    const bandIndex = row + BigInt(Math.round(between(-3.5, 3.5)));
    const q = quoteBox(book, boxAt(market, bandIndex, column, zoom), o.price, o.publishTime, sigma);
    if (!q.ok || q.multBps < 15_000 || q.multBps > 120_000) continue;
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      ix.placeTap({ signer: bot.publicKey, owner: bot.publicKey, market: m, bandIndex, column, zoom, stake, minMultBps: Math.floor(q.multBps * 0.85) }),
    );
    tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
    tx.feePayer = bot.publicKey;
    tx.sign(bot);
    await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    return `tapped ${m.symbol} $${Number(stake) / 1e6} at ${(q.multBps / 1e4).toFixed(1)}x`;
  }
  return `${m.symbol}: no box in range this time`;
}

/** Starts one independent loop per bot wallet, each tapping every 20-90 seconds. */
export function startCrowd(er: Connection, bots: Keypair[], markets: MarketKeys[], log: (...a: unknown[]) => void) {
  for (const bot of bots) {
    const name = `house·${bot.publicKey.toBase58().slice(0, 4)}`;
    let lastNote = "";
    const loop = async () => {
      try {
        const note = await tapOnce(er, bot, markets);
        // log taps, but only log a repeated problem once
        if (note.startsWith("tapped") || note !== lastNote) log(`${name} ${note}`);
        lastNote = note;
      } catch (e) {
        log(`${name} tap failed: ${explainError(e)}`);
      }
      setTimeout(() => void loop(), between(20_000, 90_000));
    };
    setTimeout(() => void loop(), between(3_000, 20_000));
  }
  log(`house players: ${bots.length} wallet(s) ${bots.map((b) => b.publicKey.toBase58().slice(0, 4)).join(", ")}`);
}

