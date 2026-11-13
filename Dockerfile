FROM node:24-alpine

# tini forwards signals and reaps the per-render child processes.
RUN apk add --no-cache tini

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
# Example pages. As an HA app, pages are read from the app's config folder instead.
COPY pages ./pages

EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
