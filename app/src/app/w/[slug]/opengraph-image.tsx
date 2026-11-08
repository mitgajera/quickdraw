import { ImageResponse } from "next/og";
import { parseWin } from "./win";

export const alt = "A winning Quickdraw tap";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#0A0A0C", LINE = "#222228", INK = "#F2F2F4", MUTE = "#8B8B94", WIN = "#3DD68C";

/** Social preview for a shared win. */
export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const w = parseWin((await params).slug) ?? { symbol: "SOL", mult: "2.00", payout: "2.00" };
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: BG, color: INK, padding: 72 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <svg width="56" height="56" viewBox="0 0 32 32">
            <path d="M2.5 20.5 H7.5 L11 12.5 L15 25 L27 8" fill="none" stroke={INK} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M19.5 7.5 H27.5 V15.5" fill="none" stroke={INK} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div style={{ fontSize: 40, fontWeight: 700 }}>Quickdraw</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 34, color: MUTE }}>{`Hit on ${w.symbol}/USD at ${w.mult}x`}</div>
          <div style={{ fontSize: 168, fontWeight: 700, color: WIN, lineHeight: 1 }}>{`+$${w.payout}`}</div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 28, color: MUTE }}>
          <div style={{ display: "flex" }}>Tap the box the price will hit. Settled on-chain.</div>
          <div style={{ display: "flex", border: `2px solid ${LINE}`, borderRadius: 999, padding: "8px 20px", color: INK }}>Solana devnet</div>
        </div>
      </div>
    ),
    size,
  );
}
