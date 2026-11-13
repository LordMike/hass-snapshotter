FROM node:24-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PUPPETEER_SKIP_DOWNLOAD=true \
    CHROMIUM_PATH=/usr/bin/chromium-headless-shell \
    NODE_ENV=production

# chromium-headless-shell is the lightweight headless-only Chromium build.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium-headless-shell \
        fonts-dejavu-core \
        fonts-noto-color-emoji \
        tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

EXPOSE 8080
# tini reaps Chromium's child processes when a browser is closed.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
