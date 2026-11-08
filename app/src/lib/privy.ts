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
  const address = wallet?.address;

  // The dashboard's embedded-wallet setting can override createOnLogin; if no Solana wallet shows up
  // shortly after sign-in, create it here so the player is never stuck on "Creating wallet…".
  const hasSolanaAccount = !!user?.linkedAccounts.some(
    (a) => a.type === "wallet" && "chainType" in a && a.chainType === "solana",
  );
  const creating = useRef(false);
  useEffect(() => {
    if (!ready || !authenticated || !walletsReady || address || hasSolanaAccount || creating.current) return;
    const t = setTimeout(() => {
      creating.current = true;
      setWalletError(null);
      createWallet()
        .catch((e) => setWalletError(`Could not create your wallet: ${explainError(e)}`))
        .finally(() => { creating.current = false; });
    }, CREATE_GRACE_MS);
    return () => clearTimeout(t);
  }, [ready, authenticated, walletsReady, address, hasSolanaAccount, createWallet]);
  useEffect(() => { if (address) setWalletError(null); }, [address]);

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
      authToken: () => tokenRef.current(),
    };
    // re-create only when the wallet itself changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const name = user?.google?.name ?? user?.twitter?.username ?? user?.google?.email ?? null;
  return {
    ready: ready && (!authenticated || walletsReady), authenticated, login, logout, signer, name, walletError,
    retryWallet: () => { creating.current = false; setWalletError(null); void createWallet().catch((e) => setWalletError(`Could not create your wallet: ${explainError(e)}`)); },
  };
}
