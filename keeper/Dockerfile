# Quickdraw keeper: records oracle ticks into the candle rings on the MagicBlock rollup and settles
# taps. Build from the repo root: docker build -f keeper/Dockerfile .
FROM node:22-slim
WORKDIR /repo
# never stop at corepack's interactive "download pnpm?" prompt
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# workspace manifests first, so dependency installs are cached across code changes
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY sdk/package.json sdk/
COPY keeper/package.json keeper/
COPY app/package.json app/
RUN pnpm install --frozen-lockfile --filter "@quickdraw/keeper..."

COPY sdk sdk
COPY keeper keeper

# the operator key arrives as the KEEPER_SECRET environment variable (never baked into the image)
ENV MARKETS=SOL,BTC,ETH
EXPOSE 8787
# run tsx directly: going through pnpm at start-up can hang silently on a fresh host (corepack)
WORKDIR /repo/keeper
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
