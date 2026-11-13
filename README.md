# ha-snapshotter

Renders Home Assistant data to PNG images for e-paper displays, such as
OpenDisplay panels fed by `opendisplay.drawcustom` with a `dlimg` element.

There is no browser. A page is a small JS file that turns `hass` into HTML and
CSS; [Takumi](https://github.com/kane50613/takumi), a Rust HTML/CSS renderer,
turns that into a PNG. Each render runs in a short-lived child process, so
between renders only a small Node process is running.

Measured in Docker on a desktop, rendering an 800x480 page with the 6-colour
palette: ~0.55 s per render (also with one CPU), ~125 MB peak, ~40 MB between
renders. A Pi-class host will be slower.

## Pages

A page is `pages/<name>.js` (in the app: `/addon_configs/<slug>/pages/`):

```js
export const size = [800, 480];

export default function render(hass, { html, raw, mdi, now, timeZone }) {
  const temp = hass.states["sensor.outdoor_temperature"];
  return html`
    <style>.big { font-size: 64px; display: flex; align-items: center; }</style>
    <div class="big">${mdi("mdi:thermometer", { size: 64 })} ${temp?.state ?? "--"}°</div>`;
}
```

- `hass.states` works like the frontend's: the page reads what it needs, and
  only those entities are fetched from HA's REST API. The list is remembered
  per page, so later renders fetch it in one go. `hass.config` is HA's
  `/api/config`.
- `html` escapes interpolated values; `raw()` passes trusted markup (e.g. an
  SVG chart) through. `mdi("mdi:name", { size, color })` gives any Material
  Design Icon as inline SVG.
- `now` is the render time and `timeZone` HA's time zone; format dates with
  `Intl.DateTimeFormat(..., { timeZone })`. The container itself runs in UTC.
- CSS: flexbox, grid, absolute positioning, inline SVG. No JavaScript runs in
  the page and there is no `<canvas>`; draw charts as SVG.
- Roboto (400/500/700) is built in; extra fonts go in `pages/fonts/`.
- Pages are re-read when the file changes.

`pages/screen-21-5.js` is a complete example.

## Usage

```
GET /page/<name>?palette=6c&dither=none
```

| Parameter | Default | Description |
|---|---|---|
| `viewport` | `800x480` | Output size, `WIDTHxHEIGHT`, when the page doesn't export `size` |
| `palette` | none | Map to a panel palette: `bw`, `bwr`, `bwry`, `6c` (white, black, red, yellow, blue, green). Without it the PNG is returned as rendered |
| `dither` | `none` | `none`, `floyd_steinberg`, `burkes`, `atkinson`, `ordered`, ... With `none`, anti-aliased edges become black, white or a neighbouring ink, so text never gains coloured fringes; colours not on the panel snap to the nearest ink. Pixels already in a pure ink colour are never dithered |

The response header `X-Render-Timings` gives milliseconds per phase. Rotation
is left to the display (`opendisplay.drawcustom` has `rotate`).

Page names are limited to `[a-z0-9_-]` and resolved inside the pages folder.
The endpoint has no authentication of its own.

## Configuration

| Option (app) | Env (Docker) | Default | |
|---|---|---|---|
| `ha_url` | `HA_URL` | | HA base URL as the container reaches it |
| `ha_token` | `HA_TOKEN` | | Long-lived access token, ideally of a dedicated user |
| `render_timeout_ms` | `RENDER_TIMEOUT_MS` | `30000` | Maximum time for one render |
| | `PAGES_DIR` | `/config/pages` or `./pages` | Folder with pages |
| | `PORT` | `8080` | |

## Local Docker

```
cp .env.example .env   # fill in HA_URL and HA_TOKEN
docker compose up --build
curl -o out.png "http://localhost:8080/page/screen-21-5?palette=6c"
```

## Development

```
npm install
npm test
```
