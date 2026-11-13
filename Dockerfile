FROM node:24-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci --omit=dev

# Runtime: Debian's own Node (no npm/yarn) and the headless-only Chromium build.
FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        nodejs \
        ca-certificates \
        chromium-headless-shell \
        fonts-dejavu-core \
        fonts-liberation \
        fonts-noto-color-emoji \
        tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production CHROMIUM_PATH=/usr/bin/chromium-headless-shell
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Example pages. As an HA app, pages are read from the app's config folder instead.
COPY pages ./pages

EXPOSE 8080
# tini reaps Chromium's child processes when a browser is closed.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
