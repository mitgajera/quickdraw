import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { ix } from "./instructions";
import { marketKeys } from "./pdas";

test("builds instructions from the IDL", () => {
  const owner = Keypair.generate().publicKey;
  const tap = ix.placeTap({ signer: owner, owner, market: marketKeys("SOL"), bandIndex: 2251n, column: 250_002,
    zoom: 1, stake: 5_000_000n, minMultBps: 0 });
  assert.equal(tap.keys.length, 6);
  assert.equal(tap.data.length, 8 + 8 + 8 + 1 + 8 + 4);
  assert.equal(ix.delegatePlayer(owner).keys.at(-1)!.isSigner, false);
});
