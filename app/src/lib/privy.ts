"use client";

// Privy sign-in (Google / X) with an embedded Solana wallet that signs silently: players never see a
// wallet popup. Exposes it as the same AppSigner the rest of the app uses.
import { useEffect, useMemo, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useCreateWallet, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { PublicKey, Transaction } from "@solana/web3.js";
import { explainError } from "@quickdraw/sdk";
import type { AppSigner } from "./chain";

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "cmw7jsye300eu0hjq0s6f7jns";

/** How long to wait for Privy's own create-on-login before creating the wallet ourselves. */
const CREATE_GRACE_MS = 2500;
/** How long a signature may wait for Privy's signing iframe to finish booting. */
const WALLET_WAIT_MS = 20_000;

/** Polls `get` until it returns a value or `ms` passes. */
async function waitFor<T>(get: () => T | undefined, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (let v = get(); ; v = get()) {
    if (v !== undefined || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function usePrivySigner() {
  const { ready, authenticated, login, logout, user, getAccessToken } = usePrivy();
  const tokenRef = useRef(getAccessToken);
  tokenRef.current = getAccessToken;
  const { wallets, ready: walletsReady } = useWallets();
  const { signTransaction } = useSignTransaction();
  const { createWallet } = useCreateWallet();
  const [walletError, setWalletError] = useState<string | null>(null);
  // the hook's function identity may change between renders; the signer must not
  const signRef = useRef(signTransaction);
  signRef.current = signTransaction;

  // Prefer Privy's embedded wallet; it is the one that signs without a popup.
  const wallet = authenticated
    ? wallets.find((w) => w.standardWallet?.name?.toLowerCase().includes("privy")) ?? wallets[0]
    : undefined;
  const walletRef = useRef(wallet);
  walletRef.current = wallet;

  // Privy knows the wallet's address the moment sign-in finishes (it is on the user record), well
  // before its signing iframe has booted. Use it straight away so the app never waits on "Creating
  // wallet…" for a wallet that already exists; only an actual signature waits for the iframe.
  const linked = authenticated
    ? user?.linkedAccounts.find(
      (a): a is Extract<typeof a, { type: "wallet" }> =>
        a.type === "wallet" && "chainType" in a && a.chainType === "solana" && a.walletClientType === "privy",
    )
    : undefined;
  const address = wallet?.address ?? linked?.address;

  // If no Solana wallet shows up shortly after sign-in (the dashboard setting can override
  // createOnLogin), create it here so the player is never stuck on "Creating wallet…".
  const creating = useRef(false);
  useEffect(() => {
    if (!ready || !authenticated || !walletsReady || address || creating.current) return;
    const t = setTimeout(() => {
      creating.current = true;
      setWalletError(null);
      createWallet()
        .catch((e) => setWalletError(`Could not create your wallet: ${explainError(e)}`))
        .finally(() => { creating.current = false; });
    }, CREATE_GRACE_MS);
    return () => clearTimeout(t);
  }, [ready, authenticated, walletsReady, address, createWallet]);
  useEffect(() => { if (address) setWalletError(null); }, [address]);

  const signer = useMemo<AppSigner | null>(() => {
    if (!address) return null;
    return {
      kind: "wallet",
      publicKey: new PublicKey(address),
      signTransaction: async (tx: Transaction) => {
        const w = await waitFor(() => (walletRef.current?.address === address ? walletRef.current : undefined), WALLET_WAIT_MS);
        if (!w) throw new Error("Your wallet is still loading. Try again in a moment.");
        const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        const { signedTransaction } = await signRef.current({
          transaction: new Uint8Array(bytes),
          wallet: w,
          chain: "solana:devnet",
          options: { uiOptions: { showWalletUIs: false } },
        });
        return Transaction.from(signedTransaction);
      },
      authToken: () => tokenRef.current(),
    };
  }, [address]);

  const name = user?.google?.name ?? user?.twitter?.username ?? user?.google?.email ?? null;
  return {
    ready, authenticated, login, logout, signer, name, walletError,
    retryWallet: () => { creating.current = false; setWalletError(null); void createWallet().catch((e) => setWalletError(`Could not create your wallet: ${explainError(e)}`)); },
  };
}
