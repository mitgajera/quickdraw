# Quickdraw

**Fastest tap wins.**

Tap trading on Solana. A live price chart becomes a grid of boxes; tap the box you think the price will hit. If it touches your box in time, you win at that box's multiplier. Every tap is a real on-chain trade, confirmed in milliseconds on a MagicBlock ephemeral rollup with Pyth prices, and settled back to Solana.

- **Instant:** no wallet popups, no gas; deposit once and tap.
- **Provably fair:** odds are computed on-chain and every result is settled from on-chain price data.
- **Be the house:** anyone can deposit USDC into the house vault and earn the edge.
- **Multiplayer:** see everyone's taps land live.

Built for the [MLH x Solana Hackathon](https://events.mlh.com/events/15200-solana-hackathon) (Nov 6–8, 2026).

## Devnet

- Program: `7TBHSjenh1DFt7C8vnNVfXDLbZ3cCgEeAa4XcTUvF6Au`
- Plays with Circle's devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`). Get 20 at [faucet.circle.com](https://faucet.circle.com/) (USDC, Solana Devnet).
- Taps and settlement run on MagicBlock's Asia ephemeral rollup (`devnet-as.magicblock.app`).

## Layout

| Path | What |
|---|---|
| `programs/quickdraw` | Anchor program: markets, per-second candle ring, on-chain odds, taps, settlement, USDC house book |
| `sdk` | TypeScript client: accounts, IDL-driven instructions, the same odds math as the program |
| `keeper` | Always-on service: records oracle ticks on the rollup and settles taps; `bootstrap` and `e2e` scripts |
| `app` | Next.js game |

## Deploy

**Keeper on Render.** New → Blueprint → this repo (uses `render.yaml`, Docker, Singapore). In the service's
environment set `KEEPER_SECRET` to the keeper wallet's keypair JSON array (on Windows:
`Get-Content wallets\operator.json | Set-Clipboard`, then paste). The free plan sleeps after ~15 minutes
without traffic, which stops ticks and settlement, so use Starter or ping `/health` every few minutes.

**App on Vercel.** Import the repo, set **Root Directory** to `app` (framework: Next.js; pnpm is detected
from the workspace), and add `NEXT_PUBLIC_KEEPER_URL` = the keeper's Render URL. Optional:
`NEXT_PUBLIC_BASE_RPC` for a dedicated devnet RPC.

**One-time devnet setup** (already done for the program above):

```bash
HOUSE_KEYPAIR=path/to/house.json MARKETS=SOL,BTC,ETH pnpm --filter @quickdraw/keeper bootstrap
PLAYER_KEYPAIR=path/to/player.json pnpm --filter @quickdraw/keeper e2e
```
