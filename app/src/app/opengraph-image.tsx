import { ImageResponse } from "next/og";

export const alt = "Quickdraw — fastest tap wins. Tap trading on Solana.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#0E0F11", PANEL = "#16181C", LINE = "#2A2D33", INK = "#ECEDEE", MUTE = "#8B8F98", ACCENT = "#FFB224";

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
              <rect width="32" height="32" rx="7" fill={ACCENT} />
              <rect x="19" y="5" width="9" height="9" rx="1.8" fill={BG} />
              <path d="M5 25 L11 18 L15.5 21 L21 13.5" fill="none" stroke={BG} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div style={{ fontSize: 44, fontWeight: 700, letterSpacing: 8 }}>QUICKDRAW</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.05 }}>Fastest tap wins.</div>
            <div style={{ fontSize: 30, color: MUTE, lineHeight: 1.35 }}>
              Tap the box the price will hit. Odds priced on-chain, taps confirmed in milliseconds on a MagicBlock rollup.
            </div>
          </div>
          <div style={{ display: "flex", gap: 14, fontSize: 24 }}>
            <div style={{ display: "flex", border: `2px solid ${ACCENT}`, color: ACCENT, padding: "8px 16px" }}>SOLANA DEVNET</div>
            <div style={{ display: "flex", border: `2px solid ${LINE}`, color: MUTE, padding: "8px 16px" }}>SOL · BTC · ETH</div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 56, flex: 1, background: PANEL, border: `2px solid ${LINE}`, padding: 18, gap: 8 }}>
          {ROWS.map((row, i) => (
            <div key={i} style={{ display: "flex", gap: 8, flex: 1 }}>
              {row.map((v, j) => {
                const hit = i === 1 && j === 2;
                return (
                  <div key={j} style={{
                    flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30,
                    border: `2px solid ${hit ? ACCENT : LINE}`, background: hit ? ACCENT : "transparent",
                    color: hit ? BG : v.length > 3 || v === "·" ? MUTE : ACCENT, fontWeight: hit ? 700 : 400,
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
