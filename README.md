# ha-snapshotter

Renders Home Assistant data to PNG images for e-paper displays, such as
OpenDisplay panels fed by `opendisplay.drawcustom` with a `dlimg` element.

There is no browser. A page is a small JS file that turns `hass` into HTML and
CSS; [Takumi](https://github.com/kane50613/takumi), a Rust HTML/CSS renderer,
turns that into a PNG. Each render runs in a short-lived child process, so
between renders only a ~20 MB Node process is running. A render takes well
under a second on a desktop (~85 MB peak).

## Install as a Home Assistant app

1. Copy this folder to `/addons/ha_snapshotter` on the HA host (Samba, SSH).
2. Settings → Apps → App store → ⋮ → Check for updates; "ha-snapshotter"
   appears under Local apps. Install and start it. It connects to HA by itself;
   no token is needed.
3. Put pages in `/config/dashboard-pages/<name>.js` (the `pages_dir` option).
4. Open `http://<ha-host>:10010/` in a browser to list and preview pages.

Use it from a display:

```yaml
action: opendisplay.drawcustom
data:
  payload:
    - type: dlimg
      url: http://local-ha-snapshotter:8080/page/screen-21-5?palette=6c
      x: 0
      y: 0
      xsize: 800
      ysize: 480
```

`local-ha-snapshotter:8080` is how HA itself reaches the app; browsers and
other hosts use `http://<ha-host>:10010`.

## Pages

```js
export const size = [800, 480]; // optional, default 800x480

export default function render(hass, { html, raw, mdi, now, timeZone, locale }) {
  const temp = hass.states["sensor.outdoor_temperature"];
  return html`
    <style>.big { font-size: 64px; display: flex; align-items: center; background: #fff; }</style>
    <div class="big">${mdi("mdi:thermometer", { size: 64 })} ${temp?.state ?? "--"}°</div>`;
}
```

- The default export is called for every render and returns markup.
- `hass.states` works like the frontend's: the page reads what it needs, and
  all states are fetched in one request. Unknown entities read as `undefined` and are
  listed in the `X-Render-Warnings` response header and the log.
  `hass.config` is HA's `/api/config`. There is no way to list all entities or
  call services or websocket commands.
- `html` escapes interpolated values; `raw()` passes trusted markup (an SVG
  chart) through. Escaping does not cover CSS, so don't put entity values in
  `style="..."`. `mdi("mdi:name", { size, color })` gives any Material Design
  Icon as inline SVG.
- `now` is the render time, `timeZone` and `locale` come from HA. The
  container runs in UTC, so format times with `Intl.DateTimeFormat(locale, { timeZone })`.
- CSS: flexbox, grid, absolute positioning, transforms, inline SVG. No
  JavaScript runs in the page and there is no `<canvas>`; draw charts as SVG.
- Roboto 400/500/700 is built in; extra fonts go in `<pages_dir>/fonts/`.
- Pages are re-read when the file changes. Pages are trusted code: they run
  inside the app with its access to Home Assistant.

`pages/screen-21-5.js` and `pages/screen-30-5.js` are complete examples.

## Endpoints

| | |
|---|---|
| `GET /` | Lists pages with preview links |
| `GET /page/<name>` | Full-colour PNG |
| `GET /page/<name>?palette=6c` | PNG on a panel palette: `bw`, `bwr`, `bwry`, `6c` (white, black, red, yellow, blue, green). Colours snap to the nearest ink; anti-aliased edges become black, white or a neighbouring ink, so text never gains coloured fringes. No dithering |
| `GET /page/<name>.html` | The page's markup, for debugging layout in a browser |
| `GET /healthz` | `ok` |

Responses carry `X-Render-Timings` (ms per phase), `X-Render-Entities` and,
when something is off, `X-Render-Warnings`. Errors are plain text with the
status: 400 bad name or parameter, 404 unknown page (lists the available
ones), 500 page error (with page line and unknown entities), 502 Home
Assistant unreachable or rejecting the token, 503 not configured or busy,
504 render timeout. The endpoint has no authentication of its own.

## Configuration

| Option (app) | Env (Docker) | Default | |
|---|---|---|---|
| `pages_dir` | `PAGES_DIR` | `/homeassistant/dashboard-pages` (app), `./pages` | Folder with pages |
| `render_timeout_ms` | `RENDER_TIMEOUT_MS` | `30000` | Maximum time for one render |
| `ha_url` | `HA_URL` | Supervisor (app) | Home Assistant base URL; required outside the app |
| `ha_token` | `HA_TOKEN` | Supervisor (app) | Long-lived access token; required outside the app |

## Standalone Docker

```
docker build -t ha-snapshotter .
docker run -p 8080:8080 -v "$PWD/pages:/app/pages:ro" -e HA_URL=https://ha.example.com -e HA_TOKEN=... ha-snapshotter
```

## Development

```
npm install
npm test
HA_URL=... node --env-file=.env src/server.js
```
