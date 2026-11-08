import { ImageResponse } from "next/og";

export const alt = "Quickdraw — fastest tap wins. Tap trading on Solana.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#0A0A0C", PANEL = "#121215", LINE = "#222228", INK = "#F2F2F4", MUTE = "#8B8B94", ACCENT = "#F2F2F4", WIN = "#3DD68C";

// a static slice of the board: multipliers grow away from the price, one box hit
const ROWS = [
  ["·", "42x", "16x", "11x"],
  ["13x", "4.5x", "4.2x", "4.4x"],
  ["2.2x", "2.5x", "3.0x", "3.5x"],
  ["1.2x", "2.1x", "2.7x", "3.2x"],
  ["1.9x", "2.4x", "2.9x", "3.4x"],
];

/** Social preview for links to the game. */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: BG, color: INK, padding: 64, fontFamily: "monospace" }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 560 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <svg width="64" height="64" viewBox="0 0 32 32">
              <path d="M2.5 20.5 H7.5 L11 12.5 L15 25 L27 8" fill="none" stroke={INK} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M19.5 7.5 H27.5 V15.5" fill="none" stroke={INK} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div style={{ fontSize: 46, fontWeight: 700, letterSpacing: -1 }}>Quickdraw</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.05 }}>Fastest tap wins.</div>
            <div style={{ fontSize: 30, color: MUTE, lineHeight: 1.35 }}>
              Tap the box the price will hit. Odds priced on-chain, taps confirmed in milliseconds on a MagicBlock rollup.
            </div>
          </div>
          <div style={{ display: "flex", gap: 14, fontSize: 24 }}>
            <div style={{ display: "flex", border: `2px solid ${LINE}`, color: INK, padding: "8px 16px", borderRadius: 999 }}>Solana devnet</div>
            <div style={{ display: "flex", border: `2px solid ${LINE}`, color: MUTE, padding: "8px 16px", borderRadius: 999 }}>SOL · BTC · ETH</div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 56, flex: 1, background: PANEL, border: `2px solid ${LINE}`, padding: 18, gap: 8, borderRadius: 24 }}>
          {ROWS.map((row, i) => (
            <div key={i} style={{ display: "flex", gap: 8, flex: 1 }}>
              {row.map((v, j) => {
                const hit = i === 1 && j === 2;
                return (
                  <div key={j} style={{
                    flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30,
                    border: `1px solid ${LINE}`, borderRadius: 12, background: hit ? "rgba(61,214,140,.16)" : "transparent",
                    color: hit ? WIN : v === "·" ? MUTE : parseFloat(v) < 3 || parseFloat(v) >= 10 ? INK : MUTE, fontWeight: hit ? 700 : 400,
                  }}>{hit ? "+$4.20" : v}</div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
