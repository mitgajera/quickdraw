import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/Providers";
import "./globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://quickdraw-beta.vercel.app";
const DESCRIPTION = "Tap the box the price will hit. Odds priced on-chain, taps confirmed in milliseconds on a MagicBlock rollup, every result provable on Solana.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: "Quickdraw | fastest tap wins",
  description: DESCRIPTION,
  openGraph: { title: "Quickdraw | fastest tap wins", description: DESCRIPTION, url: SITE, siteName: "Quickdraw", type: "website" },
  twitter: { card: "summary_large_image", title: "Quickdraw | fastest tap wins", description: DESCRIPTION },
};

export const viewport: Viewport = { themeColor: "#0A0A0C", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
