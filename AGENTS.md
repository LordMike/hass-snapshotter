## Purpose

hass-snapshotter renders Home Assistant data to PNG images for e-paper displays, without a browser: a page is a JS module returning HTML+CSS, Takumi renders it. Optimize for low idle and peak memory on small hosts (HA Green / Pi 4), predictable output, and clear error messages.

## Do / Don't

- Do: keep `config.yaml`, `package.json` version, README and the app entry in `LordMike/hass-addons` aligned when changing release metadata or options.
- Do: keep each render in the short-lived child process (`src/page-worker.js`); the parent must stay small between renders.
- Do: report problems a page author can fix (unknown entities, icons, parameters) as warnings or 4xx/5xx messages that name the page, line and fix.
- Don't: add a browser engine, or a widget framework; pages are plain JS returning markup.
- Don't: commit secrets. The committed `.env` holds only Docker build settings for CI; local secrets go in `.tmp/dev.env`.
- Don't: run the server against real Home Assistant unless asked.

## Pushback / quality bar

- Before starting new projects or automation, evaluate whether the effort is justified and push back if build time exceeds the time it would save.
- If a request would introduce hacks, unclear behavior, or long-term maintenance risk, push back and propose a safer alternative.
- Avoid obvious performance pitfalls; call them out and offer a better approach.
- Prefer clear, simple code over clever or verbose implementations.

## Core workflows

- Test: `npm test`
- Build: `docker build -t hass-snapshotter .`
- Run: `node --env-file=.tmp/dev.env src/server.js` DO NOT RUN AUTOMATICALLY UNLESS ASKED TO
- Release: push a plain version tag (`0.4.0`, no `v`); CI publishes `ghcr.io/lordmike/hass-snapshotter` (amd64, arm64) and bumps `LordMike/hass-addons`.

## Repo conventions

- `src/server.js`: HTTP, parameters, queue, child lifecycle. `src/page-worker.js`: one render per child process.
- `src/pages.js`: page loading, `hass`/ctx, Takumi. `src/hass.js`: REST client. `src/image.js`: palette mapping and indexed PNG. `src/html.js`: escaping template tag.
- `pages/`: example pages (also the default `PAGES_DIR` outside the app). They are not baked into the image.
- Node ESM, Node 22.2+; no build step.
