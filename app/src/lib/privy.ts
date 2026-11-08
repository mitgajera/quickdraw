"use client";

// Privy sign-in (Google / X) with an embedded Solana wallet that signs silently: players never see a
// wallet popup. Exposes it as the same AppSigner the rest of the app uses.
import { useMemo, useRef } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { PublicKey, Transaction } from "@solana/web3.js";
import type { AppSigner } from "./chain";

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "cmw7jsye300eu0hjq0s6f7jns";

export function usePrivySigner() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { signTransaction } = useSignTransaction();
  // the hook's function identity may change between renders; the signer must not
  const signRef = useRef(signTransaction);
  signRef.current = signTransaction;

  const wallet = authenticated ? wallets[0] : undefined;
  const address = wallet?.address;
  const signer = useMemo<AppSigner | null>(() => {
    if (!wallet || !address) return null;
    return {
      kind: "wallet",
      publicKey: new PublicKey(address),
      signTransaction: async (tx: Transaction) => {
        const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        const { signedTransaction } = await signRef.current({
          transaction: new Uint8Array(bytes),
          wallet,
          chain: "solana:devnet",
          options: { uiOptions: { showWalletUIs: false } },
        });
        return Transaction.from(signedTransaction);
      },
    };
    // re-create only when the wallet itself changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const name = user?.google?.name ?? user?.twitter?.username ?? user?.google?.email ?? null;
  return { ready: ready && (!authenticated || walletsReady), authenticated, login, logout, signer, name };
}
