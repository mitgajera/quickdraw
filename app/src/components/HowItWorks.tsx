"use client";

import { useEffect } from "react";
import { PROGRAM_ID } from "@quickdraw/sdk";
import type { Book } from "@quickdraw/sdk";

/** The rules and why they are fair, in plain words, with the house's live parameters. */
export function HowItWorks({ book, onClose }: { book: Book | null; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const edge = book ? `${(book.edgeBps / 100).toFixed(0)}%` : "7%";
  const minX = book ? `${(book.minMultBps / 1e4).toFixed(1)}x` : "1.1x";
  const maxX = book ? `${(book.maxMultBps / 1e4).toFixed(0)}x` : "50x";
  const maxWin = book ? `$${(Number(book.maxProfit) / 1e6).toFixed(0)}` : "$50";
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal how" role="dialog" aria-label="How Quickdraw works" onClick={(e) => e.stopPropagation()}>
        <div className="card-h"><span>How it works</span><button className="iconbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <ol className="howlist">
          <li>
            <b>Tap a box.</b> Each column is a 4-second window, each row a price band. If the price touches your box
            while its column is live, you win stake × multiplier. Columns lock 1 second before they open.
          </li>
          <li>
            <b>Odds are computed on-chain.</b> When you tap, the program prices the box itself: the chance the price
            touches that band in that window, from volatility it measures on its own price record. Multiplier = (1 − {edge}{" "}
            house edge) ÷ chance, between {minX} and {maxX}. The app shows the same math, but the program decides.
          </li>
          <li>
            <b>Every result is provable.</b> A keeper writes the Pyth Lazer price into an on-chain per-second candle
            record 8 times a second. A tap wins if its window&apos;s lowest-to-highest price overlaps the box. Anyone can
            call settle, and each result has a <i>proof</i> showing the recorded prices against your box.
          </li>
          <li>
            <b>Fast because of MagicBlock.</b> Your account runs on a MagicBlock ephemeral rollup, so a tap confirms in
            milliseconds and costs nothing. A browser key that can only tap (not withdraw) signs it for 24 hours.
          </li>
          <li>
            <b>Your money never leaves your wallet until you tap.</b> At sign-in your wallet lets the house vault take
            stakes, nothing is deposited. Each tap&apos;s stake is pulled on Solana by a MagicBlock Magic Action the program
            schedules from the rollup; a win is paid straight back to your wallet the same way, about a second after it
            settles. We pay every network fee.
          </li>
          <li>
            <b>An on-chain house.</b> Winnings come from a USDC pool with LP shares that earns the edge. To keep it
            solvent, one tap can win at most {maxWin} profit, and open payouts are capped at {book ? `${book.maxExposureBps / 100}%` : "50%"} of the pool. Boxes over
            a limit show struck through.
          </li>
        </ol>
        <div className="row">
          <a className="btn" href={`https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`} target="_blank" rel="noreferrer">Program on Solana ↗</a>
          <a className="btn" href="https://github.com/mitgajera/quickdraw" target="_blank" rel="noreferrer">Source ↗</a>
          <button className="btn primary" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  );
}
