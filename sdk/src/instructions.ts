// IDL-driven instruction builders. Account lists, PDAs and discriminators come straight from the
// Anchor IDL, so the client cannot drift from the program.
import { Buffer } from "buffer";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import idlJson from "./idl.json";
import { ER_VALIDATOR, PROGRAM_ID } from "./constants";
import { ataOf, bookPda, mintPda, playerPda, type MarketKeys } from "./pdas";

type IdlType = string | { array: [IdlType, number] } | { defined: { name: string } | string };
interface IdlSeed { kind: "const" | "account" | "arg"; value?: number[]; path?: string }
interface IdlAccount {
  name: string; signer?: boolean; writable?: boolean; address?: string;
  pda?: { seeds: IdlSeed[]; program?: IdlSeed };
}
interface IdlInstruction { name: string; discriminator: number[]; accounts: IdlAccount[]; args: { name: string; type: IdlType }[] }
interface Idl {
  address: string; instructions: IdlInstruction[];
  types: { name: string; type: { fields?: { name: string; type: IdlType }[] } }[];
  events?: { name: string; discriminator: number[] }[];
}

export const IDL = idlJson as unknown as Idl;

type Value = number | bigint | boolean | PublicKey | Value[] | { [k: string]: Value };

function encode(type: IdlType, value: Value, out: Buffer[]): void {
  if (typeof type === "string") {
    const n = (bytes: number, write: (b: Buffer) => void) => { const b = Buffer.alloc(bytes); write(b); out.push(b); };
    switch (type) {
      case "u8": return n(1, (b) => b.writeUInt8(Number(value)));
      case "bool": return n(1, (b) => b.writeUInt8(value ? 1 : 0));
      case "u16": return n(2, (b) => b.writeUInt16LE(Number(value)));
      case "u32": return n(4, (b) => b.writeUInt32LE(Number(value)));
      case "u64": return n(8, (b) => b.writeBigUInt64LE(BigInt(value as number | bigint)));
      case "i64": return n(8, (b) => b.writeBigInt64LE(BigInt(value as number | bigint)));
      case "pubkey": out.push((value as PublicKey).toBuffer()); return;
      default: throw new Error(`unsupported IDL type ${type}`);
    }
  }
  if ("array" in type) {
    const [inner, len] = type.array;
    for (let i = 0; i < len; i++) encode(inner, (value as Value[])[i]!, out);
    return;
  }
  const name = typeof type.defined === "string" ? type.defined : type.defined.name;
  const def = IDL.types.find((t) => t.name === name);
  for (const f of def?.type.fields ?? []) encode(f.type, (value as Record<string, Value>)[f.name]!, out);
}

/**
 * Builds `name` with accounts resolved from `known` (by account name, or by seed path such as
 * `market.oracle`), then the IDL's fixed addresses and PDA seeds.
 */
export function buildIx(
  name: string,
  given: Record<string, PublicKey>,
  args: Record<string, Value> = {},
  remaining: PublicKey[] = [],
): TransactionInstruction {
  // accounts resolved so far feed the seeds of later ones (e.g. candles is seeded by market)
  const known: Record<string, PublicKey> = { ...given };
  const def = IDL.instructions.find((i) => i.name === name);
  if (!def) throw new Error(`unknown instruction ${name}`);
  const seed = (s: IdlSeed): Buffer => {
    if (s.kind === "const") return Buffer.from(s.value!);
    const key = known[s.path!];
    if (!key) throw new Error(`${name}: missing seed account ${s.path}`);
    return key.toBuffer();
  };
  const resolve = (a: IdlAccount): PublicKey => {
    const k = known[a.name];
    if (k) return k;
    if (a.address) return new PublicKey(a.address);
    if (a.pda) {
      let program = PROGRAM_ID;
      if (a.pda.program?.kind === "const") program = new PublicKey(Buffer.from(a.pda.program.value!));
      else if (a.pda.program?.kind === "account") {
        const path = a.pda.program.path!;
        program = known[path] ?? new PublicKey(def.accounts.find((x) => x.name === path)!.address!);
      }
      return PublicKey.findProgramAddressSync(a.pda.seeds.map(seed), program)[0];
    }
    throw new Error(`${name}: cannot resolve account ${a.name}`);
  };
  const data: Buffer[] = [Buffer.from(def.discriminator)];
  for (const a of def.args) encode(a.type, args[a.name]!, data);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat(data),
    keys: [
      ...resolveAll(def.accounts, resolve, known).map((pubkey, i) => ({
        pubkey, isSigner: !!def.accounts[i]!.signer, isWritable: !!def.accounts[i]!.writable,
      })),
      ...remaining.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
  });
}

/** Resolves accounts in passes, since a PDA may be seeded by an account listed after it. */
function resolveAll(
  accounts: IdlAccount[], resolve: (a: IdlAccount) => PublicKey, known: Record<string, PublicKey>,
): PublicKey[] {
  const out: (PublicKey | undefined)[] = accounts.map(() => undefined);
  let lastError: unknown;
  for (let pass = 0; pass < accounts.length && out.includes(undefined); pass++) {
    accounts.forEach((a, i) => {
      if (out[i]) return;
      try {
        out[i] = resolve(a);
        known[a.name] ??= out[i]!;
      } catch (e) {
        lastError = e;
      }
    });
  }
  if (out.includes(undefined)) throw lastError;
  return out as PublicKey[];
}

const marketAccounts = (m: MarketKeys) => ({
  market: m.market, candles: m.candles, oracle: m.oracle, "market.oracle": m.oracle,
});

const playerAccounts = (owner: PublicKey) => ({
  owner, payer: owner, user: owner, player: playerPda(owner), "player.owner": owner,
  book: bookPda(), mint: mintPda(), user_tokens: ataOf(owner),
});

/** Typed builders for every instruction the app and keeper send. */
export const ix = {
  recordTick: (m: MarketKeys) => buildIx("record_tick", marketAccounts(m)),

  settle: (owner: PublicKey, m: MarketKeys) =>
    buildIx("settle", { ...playerAccounts(owner), ...marketAccounts(m) }),

  placeTap: (a: {
    signer: PublicKey; owner: PublicKey; market: MarketKeys;
    bandIndex: bigint; column: number; zoom: number; stake: bigint; minMultBps: number;
  }) =>
    buildIx("place_tap", { ...playerAccounts(a.owner), ...marketAccounts(a.market), signer: a.signer }, {
      band_index: a.bandIndex, column: a.column, zoom: a.zoom, stake: a.stake, min_mult_bps: a.minMultBps,
    }),

  faucet: (owner: PublicKey) => buildIx("faucet", playerAccounts(owner)),
  initPlayer: (owner: PublicKey) => buildIx("init_player", playerAccounts(owner)),
  deposit: (owner: PublicKey, amount: bigint) => buildIx("deposit", playerAccounts(owner), { amount }),
  withdraw: (owner: PublicKey, amount: bigint) => buildIx("withdraw", playerAccounts(owner), { amount }),
  setSession: (owner: PublicKey, session: PublicKey, expiresAt: number) =>
    buildIx("set_session", playerAccounts(owner), { session, expires_at: expiresAt }),
  delegatePlayer: (owner: PublicKey, validator = ER_VALIDATOR) =>
    buildIx("delegate_player", playerAccounts(owner), {}, [validator]),
  undelegatePlayer: (owner: PublicKey) => buildIx("undelegate_player", playerAccounts(owner)),
  lpAdd: (owner: PublicKey, amount: bigint) => buildIx("lp_add", playerAccounts(owner), { amount }),
  lpRemove: (owner: PublicKey, shares: bigint) => buildIx("lp_remove", playerAccounts(owner), { shares }),
};
