FROM alpine:3.23

# Alpine's Node (49 MB vs 126 MB for the official binary). icu-data-full is
# needed for non-English Intl, e.g. Danish dates. npm is only used to install
# and removed again in the same layer, along with files that are never loaded.
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN apk add --no-cache nodejs icu-data-full \
    && apk add --no-cache --virtual .build npm \
    && npm ci --omit=dev --no-audit --no-fund \
    && cd node_modules \
    # Node loads @mdi/js through "main" (commonjs); the ESM copy and types are unused.
    && rm -f @mdi/js/mdi.js @mdi/js/mdi.d.ts @mdi/js/build.js @fontsource/roboto/*.css \
    # Only Roboto 400/500/700 latin + latin-ext are registered.
    && find @fontsource/roboto/files -type f ! -name 'roboto-latin-[457]00-normal.woff2' ! -name 'roboto-latin-ext-[457]00-normal.woff2' -delete \
    && find . \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete \
    && apk del .build \
    && rm -rf /root/.npm /tmp/*
COPY src ./src

EXPOSE 8080
# Node runs as PID 1: it handles SIGTERM itself and reaps the render children it forks.
CMD ["node", "src/server.js"]
