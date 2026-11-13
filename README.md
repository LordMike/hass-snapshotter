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

It has two modes:

| | `/render/<HA path>` | `/page/<name>` |
|---|---|---|
| Renders | Any existing HA dashboard, custom cards included | A page file you write in plain JS/HTML |
| Engine | Chromium, started per render | Takumi (Rust HTML/CSS renderer), no browser |
| Render time* | ~1.1 s warm cache, ~2 s first | ~0.55 s |
| Peak memory* | ~215 MB | ~125 MB |
| Between renders | ~40-60 MB (Node only) | ~40 MB (Node only) |

\* Measured in Docker on a desktop, rendering an 800x480 dashboard with the 6-colour palette. A Pi-class host will be slower.

## Browser-free pages

A page is `pages/<name>.js` (in the app: `/addon_configs/<slug>/pages/`). It
exports a function that returns HTML with a `<style>` block:

```js
export const size = [800, 480];

export default function render(hass, { html, raw, mdi, now }) {
  const temp = hass.states["sensor.outdoor_temperature"];
  return html`
    <style>.big { font-size: 64px; display: flex; align-items: center; }</style>
    <div class="big">${mdi("mdi:thermometer", { size: 64 })} ${temp?.state ?? "--"}°</div>`;
}
```

- `hass.states` works like the frontend's: the page reads what it needs, and
  only those entities are fetched from HA's REST API. The list is remembered
  per page, so later renders fetch it in one go.
- `html` escapes interpolated values; `raw()` passes trusted markup (e.g. an
  SVG chart) through. `mdi("mdi:name", { size, color })` gives any Material
  Design Icon as inline SVG.
- CSS: flexbox, grid, absolute positioning, inline SVG. No JavaScript runs in
  the page and there is no `<canvas>`; draw charts as SVG.
- Roboto (400/500/700) is built in; extra fonts go in `pages/fonts/`.
- Pages are re-read when the file changes. Each render runs in a short-lived
  child process, so the renderer isn't kept in memory between renders.

`pages/screen-21-5.js` is a complete example.

## Usage

```
GET /render/<home-assistant path>?viewport=800x480&palette=6c&dither=none
GET /page/<name>?palette=6c&dither=none
```

| Parameter | Default | Description |
|---|---|---|
| `viewport` | `800x480` | Output size, `WIDTHxHEIGHT` |
| `palette` | none | Map to a panel palette: `bw`, `bwr`, `bwry`, `6c` (white, black, red, yellow, blue, green). Without it the raw screenshot is returned |
| `dither` | `none` | `none`, `floyd_steinberg`, `burkes`, `atkinson`, `ordered`, ... With `none`, anti-aliased edges become black, white or a neighbouring ink, so text never gains coloured fringes; colours not on the panel (e.g. light grey) snap to the nearest ink. Pixels already in a pure ink colour are never dithered |
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
| | `PAGES_DIR` | `/config/pages` or `./pages` | Folder with browser-free pages |
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
