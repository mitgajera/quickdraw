"use client";

import { WalletProvider } from "@solana/wallet-adapter-react";
import { Buffer } from "buffer";

// web3.js and the sdk expect a global Buffer in the browser
if (typeof window !== "undefined") (window as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;

/** Phantom and other Wallet Standard wallets register themselves; no adapters to list. */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider wallets={[]} autoConnect>
      {children}
    </WalletProvider>
  );
}
