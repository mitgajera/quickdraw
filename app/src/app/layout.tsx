import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_Condensed } from "next/font/google";
import { Providers } from "@/components/Providers";
import "./globals.css";

const display = IBM_Plex_Sans_Condensed({
  subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-display",
});
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Quickdraw — fastest tap wins",
  description: "Tap the box the price will hit. On-chain odds, 50ms taps, settled from on-chain candles on Solana.",
};

export const viewport: Viewport = { themeColor: "#0E0F11", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
