# Build stage: install production dependencies and drop what is never loaded.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && cd node_modules \
    # Node loads @mdi/js through "main" (commonjs); the ESM copy and types are unused.
    && rm -f @mdi/js/mdi.js @mdi/js/mdi.d.ts @mdi/js/build.js \
    # Only Roboto 400/500/700 latin + latin-ext are registered.
    && mkdir /tmp/fonts \
    && for w in 400 500 700; do for s in latin latin-ext; do \
         mv @fontsource/roboto/files/roboto-$s-$w-normal.woff2 /tmp/fonts/; done; done \
    && rm -rf @fontsource/roboto/files @fontsource/roboto/*.css \
    && mv /tmp/fonts @fontsource/roboto/files \
    && find . -name '*.map' -delete

# Runtime: plain Alpine with its own Node (49 MB vs 126 MB for the official
# binary). icu-data-full is needed for non-English Intl (e.g. Danish dates).
FROM alpine:3.23
RUN apk add --no-cache nodejs icu-data-full tini
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Example pages. As an HA app, pages are read from the app's config folder instead.
COPY pages ./pages

EXPOSE 8080
# tini forwards signals and reaps the per-render child processes.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
