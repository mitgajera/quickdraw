// The two SPL token instructions the keeper needs, without pulling in @solana/spl-token.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ATA_PROGRAM_ID, TOKEN_PROGRAM_ID, USDC_MINT } from "./constants";
import { ataOf } from "./pdas";

/** Creates `owner`'s associated token account for `mint` if it does not exist yet. */
export function createAtaIdempotent(payer: PublicKey, owner: PublicKey, mint = USDC_MINT): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataOf(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** SPL `Transfer` between the two owners' associated token accounts. */
export function transferTokens(from: PublicKey, to: PublicKey, amount: bigint, mint = USDC_MINT): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: ataOf(from, mint), isSigner: false, isWritable: true },
      { pubkey: ataOf(to, mint), isSigner: false, isWritable: true },
      { pubkey: from, isSigner: true, isWritable: false },
    ],
    data,
  });
}
