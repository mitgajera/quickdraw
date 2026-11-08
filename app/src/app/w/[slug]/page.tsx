import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { parseWin } from "./win";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const w = parseWin((await params).slug);
  if (!w) return {};
  const title = `+$${w.payout} at ${w.mult}x on ${w.symbol} · Quickdraw`;
  const description = "Tap the box the price will hit. Odds priced and settled on-chain on Solana.";
  return { title, description, openGraph: { title, description }, twitter: { card: "summary_large_image", title, description } };
}

/** The page behind a shared win: the result, and a way into the game. */
export default async function WinPage({ params }: Props) {
  const w = parseWin((await params).slug);
  if (!w) notFound();
  return (
    <main className="app sharewin">
      <div className="card pad narrow">
        <p className="muted">A Quickdraw tap on {w.symbol}/USD paid</p>
        <p className="sharebig">+${w.payout}</p>
        <p className="muted">at {w.mult}x, priced and settled on-chain on Solana.</p>
        <a className="btn primary block" href="/">Play Quickdraw</a>
      </div>
    </main>
  );
}
