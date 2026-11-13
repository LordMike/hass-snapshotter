# ha-snapshotter

Renders a Home Assistant dashboard path to a PNG, for e-paper displays such as
OpenDisplay panels fed by `opendisplay.drawcustom` with a `dlimg` element.

Chromium is started for each render and closed afterwards (configurable), so
nothing but a small Node process runs between renders. A render is only
returned once the dashboard is actually ready: the websocket is connected,
entity states are loaded, the panel is resolved, every custom element on the
page is defined and the network has gone idle. If that doesn't happen within
the timeout, the request fails with an error instead of returning a
half-loaded screenshot.

## Usage

```
GET /render/<home-assistant path>?viewport=800x480&palette=6c&dither=none
```

| Parameter | Default | Description |
|---|---|---|
| `viewport` | `800x480` | Output size, `WIDTHxHEIGHT` |
| `palette` | none | Map to a panel palette: `bw`, `bwr`, `bwry`, `6c` (white, black, red, yellow, blue, green). Without it the raw screenshot is returned |
| `dither` | `none` | `none`, `floyd_steinberg`, `burkes`, `atkinson`, `ordered`, ... Pixels that already use a pure ink colour are never dithered |
| `wait` | `0` | Extra milliseconds to wait after the page is ready |
| `lang` | HA user's | Frontend language, e.g. `en`, `da`. A language saved in the HA user's profile wins, so set it on the dedicated user instead |
| `theme`, `dark` | | HA theme name, and `dark` to request dark mode |

Rotation is left to the display (`opendisplay.drawcustom` has `rotate`).

Response headers `X-Render-Timings` (ms per phase) and `X-Render-Browser`
(`cold`/`warm`) describe the render.

### Path safety

The path is always resolved against the configured HA URL. Paths with empty,
`.` or `..` segments, schemes, hosts, ports, `@`, backslashes or encoded
variants of those are rejected, as are non-dashboard prefixes (`api`, `auth`,
`local`, ...). `allowed_paths` can restrict rendering further to specific
prefixes; the endpoint has no authentication of its own, so setting it is
recommended. A render fails if the page ends up on another origin (e.g. HA
redirecting http to https), and the token is only written to HA's own storage.

### Speed

Chromium keeps a persistent profile (`/data/chromium-profile` in the app,
`/tmp/chromium-profile` otherwise), so HA's JavaScript comes from disk cache
and V8's code cache on later launches. Renders queued back to back share one
browser launch.

## Configuration

| Option (app) | Env (Docker) | Default | |
|---|---|---|---|
| `ha_url` | `HA_URL` | | HA base URL as the container reaches it |
| `ha_token` | `HA_TOKEN` | | Long-lived access token, ideally of a dedicated user |
| `allowed_paths` | `ALLOWED_PATHS` (comma list) | any | Path prefixes that may be rendered |
| `browser_idle_seconds` | `BROWSER_IDLE_SECONDS` | `0` | Keep the browser this long after a render; `0` closes it at once |
| `ready_timeout_ms` | `READY_TIMEOUT_MS` | `45000` | Maximum time for a render |
| | `PORT` | `8080` | |
| | `TZ` | UTC | Time zone dashboards render in. The HA app gets it from the Supervisor |

## Local Docker

```
cp .env.example .env   # fill in HA_URL and HA_TOKEN
docker compose up --build
curl -o out.png "http://localhost:8080/render/lovelace/0?viewport=800x480"
```

## Development

```
npm install
npm test
```
