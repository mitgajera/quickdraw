# Quickdraw

**Fastest tap wins.**

Tap trading on Solana. A live price chart becomes a grid of boxes; tap the box you think the price will hit. If it touches your box in time, you win at that box's multiplier. Every tap is a real on-chain trade, confirmed in milliseconds on a MagicBlock ephemeral rollup with Pyth prices, and settled back to Solana.

- **Instant:** sign in with Google or X, no wallet popups, no gas: the house covers every fee and taps land on the rollup in milliseconds.
- **Provably fair:** odds are computed on-chain and every result is settled from on-chain price data.
- **An open house:** the bankroll is an on-chain LP pool with shares (`lp_add` / `lp_remove`) that earns the edge; an LP screen in the app is next.
- **Multiplayer:** see everyone's taps land live.

Built for the [MLH x Solana Hackathon](https://events.mlh.com/events/15200-solana-hackathon) (Nov 6–8, 2026).

## Devnet

- Program: `7TBHSjenh1DFt7C8vnNVfXDLbZ3cCgEeAa4XcTUvF6Au`
- Plays with Circle's devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`). New players get a little starter USDC from the keeper while its budget lasts; more is free at [faucet.circle.com](https://faucet.circle.com/) (USDC, Solana Devnet).
- Sign-in and wallets: [Privy](https://privy.io) embedded Solana wallets that sign without popups.
- Taps and settlement run on MagicBlock's Asia ephemeral rollup (`devnet-as.magicblock.app`).

## Layout

| Path | What |
|---|---|
| `programs/quickdraw` | Anchor program: markets, per-second candle ring, on-chain odds, taps, settlement, USDC house book |
| `sdk` | TypeScript client: accounts, IDL-driven instructions, the same odds math as the program |
| `keeper` | Always-on service: records oracle ticks on the rollup and settles taps; `bootstrap` and `e2e` scripts |
| `app` | Next.js game |

## Deploy

**Keeper on Render.** A Docker web service from this repo (`keeper/Dockerfile`, or New → Blueprint with
`render.yaml`). In the service's environment set `KEEPER_SECRET` to the keeper wallet's keypair JSON array
(on Windows: `Get-Content wallets\operator.json | Set-Clipboard`, then paste); optionally `BOT_SECRETS` for
the demo crowd. The keeper's wallet pays new players' fees and their starter USDC: `WELCOME_USDC`
(default `1000000`, $1) per wallet, up to `WELCOME_BUDGET` (default `15000000`, $15) per process, plus
`WELCOME_SOL_BUDGET` (default 3 SOL) and `WELCOME_PER_IP_HOUR` (default 6). Grants need a valid Privy login
token for `PRIVY_APP_ID` (checked with Privy's public keys, so no app secret is needed). The free
plan sleeps after ~15 minutes without traffic, which stops ticks and settlement, so ping `/health` every
few minutes (UptimeRobot works).

**App on Vercel.** Import the repo, set **Root Directory** to `app` (framework: Next.js; pnpm is detected
from the workspace), and add `NEXT_PUBLIC_KEEPER_URL` = the keeper's Render URL and `NEXT_PUBLIC_PRIVY_APP_ID`.
In the Privy dashboard enable Google and Twitter login and Solana embedded wallets, and add the app's
domain under allowed origins. Optional:
`NEXT_PUBLIC_BASE_RPC` for a dedicated devnet RPC.

**One-time devnet setup** (already done for the program above):

```bash
HOUSE_KEYPAIR=path/to/house.json MARKETS=SOL,BTC,ETH pnpm --filter @quickdraw/keeper bootstrap
PLAYER_KEYPAIR=path/to/player.json pnpm --filter @quickdraw/keeper e2e
```
