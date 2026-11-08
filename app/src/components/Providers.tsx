"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { Buffer } from "buffer";
import { PRIVY_APP_ID } from "@/lib/privy";

// web3.js and the sdk expect a global Buffer in the browser
if (typeof window !== "undefined") (window as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;

/** Privy: sign in with Google or X; every player gets an embedded Solana wallet that signs silently. */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["google", "twitter"],
        appearance: { theme: "dark", accentColor: "#3DD68C", walletChainType: "solana-only", landingHeader: "Sign in to Quickdraw" },
        embeddedWallets: {
          ethereum: { createOnLogin: "off" },
          solana: { createOnLogin: "all-users" },
          showWalletUIs: false,
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
