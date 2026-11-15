# hass-snapshotter

Renders Home Assistant data to PNG images for e-paper displays, such as
OpenDisplay panels fed by `opendisplay.drawcustom` with a `dlimg` element.

There is no browser. A page is a small JS file that turns `hass` into HTML and
CSS; [Takumi](https://github.com/kane50613/takumi), a Rust HTML/CSS renderer,
turns that into a PNG. Each render runs in a short-lived child process, so
between renders only a ~20 MB Node process is running. A render takes well
under a second on a desktop (~85 MB peak).

## Install as a Home Assistant app (recommended)

1. Add the app repository `https://github.com/LordMike/hass-addons` under
   Settings → Apps → App store → ⋮ → Repositories.
2. Install "hass-snapshotter" and start it. It uses a prebuilt image for
   aarch64/amd64 and connects to HA by itself; no token is needed.
3. Put pages in `/config/dashboard-pages/<name>.js` (the `pages_dir` option).
4. Open `http://<ha-host>:10010/` in a browser to list and preview pages.

To build it on the HA host instead, copy this repository to
`/addons/hass_snapshotter` (it has its own `config.yaml`) and install it from
Local apps.

Use it from a display:

```yaml
action: opendisplay.drawcustom
data:
  payload:
    - type: dlimg
      url: http://<app hostname>:8080/page/screen-21-5?palette=6c
      x: 0
      y: 0
      xsize: 800
      ysize: 480
```

HA itself reaches the app on its hostname (shown on the app's page, e.g.
`e141bb7c-hass-snapshotter` from the repository or `local-hass-snapshotter`
when built locally) at port 8080; browsers and other hosts use
`http://<ha-host>:10010`.

## Pages

```js
export const size = [800, 480]; // optional, default 800x480; may be a function of URL parameters

export default function render(hass, { html, raw, mdi, now, timeZone, locale, params, size }) {
  const temp = hass.states["sensor.outdoor_temperature"];
  return html`
    <style>.big { font-size: 64px; display: flex; align-items: center; background: #fff; }</style>
    <div class="big">${mdi("mdi:thermometer", { size: 64 })} ${temp?.state ?? "--"}°</div>`;
}
```

- The default export is called for every render and returns markup.
- `hass.states` works like the frontend's: the page reads what it needs, and
  all states are fetched in one request. Unknown entities read as `undefined` and are
  listed on the debug page (`/page/<name>.debug`), in the `X-Render-Warnings`
  response header and in the log.
  `hass.config` is HA's `/api/config`.
- `hass.areas[area_id]` (`{ area_id, name }`) and `hass.entities[entity_id]`
  (`{ entity_id, area_id }`) work like the frontend's, except that an
  entity's `area_id` already falls back to its device's area. They cost one
  extra request, made only if the page reads them; entities without an area
  are absent. There is no way to list all entities or call services or
  websocket commands.
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

### URL parameters

Every query parameter except `palette` is passed to the page as
`ctx.params` (strings), so one page can serve several displays or rooms.
`size` can be a function of them, and `ctx.size` is the size in use:

```js
// /page/room?entity=sensor.bath_temperature&label=Bad&size=small&palette=bw
export const params = ["entity", "label", "size"]; // optional: rejects typos with a 400
export const size = ({ size }) => (size === "small" ? [296, 128] : [800, 480]);

export default function render(hass, { html, params, size }) {
  const s = hass.states[params.entity ?? "sun.sun"];
  return html`<div style="width:${size[0]}px">${params.label ?? "State"}: ${s?.state ?? "--"}</div>`;
}
```

Parameter values come from the URL: interpolate them through `html` (which
escapes them) and not into `style="..."` or `raw()`. Names are limited to
letters, digits, `-` and `_`; at most 20 parameters of up to 500 characters.

## Endpoints

| | |
|---|---|
| `GET /` | Lists pages with preview links |
| `GET /page/<name>` | Full-colour PNG |
| `GET /page/<name>?palette=6c` | PNG on a panel palette: `bw`, `bwr`, `bwry`, `6c` (white, black, red, yellow, blue, green). Colours snap to the nearest ink; anti-aliased edges become black, white or a neighbouring ink, so text never gains coloured fringes. No dithering |
| `GET /page/<name>?palette=gray4` | PNG in grey levels for greyscale panels: `gray4` (black, dark grey, light grey, white) or `gray16`. Each pixel takes the nearest grey, so anti-aliased edges stay smooth |
| `GET /page/<name>?key=value` | Any other parameter goes to the page as `ctx.params` (see URL parameters) |
| `GET /page/<name>.html` | The page's markup, for debugging layout in a browser |
| `GET /page/<name>.debug` | Renders the PNG (same parameters, including `palette`) and shows a log of every step with the time since the request started, warnings, errors with their stack, the entities read and the image. Start here when a page is slow or wrong |
| `GET /healthz` | `ok` |

Responses carry `X-Render-Timings` (ms per phase), `X-Render-Entities` and,
when something is off, `X-Render-Warnings`. Errors are plain text with the
status: 400 bad name or parameter, 404 unknown page (lists the available
ones), 500 page error (with page line and unknown entities), 502 Home
Assistant unreachable or rejecting the token, 503 not configured or busy,
504 render timeout.

Authentication is off by default. With `auth_username` and `auth_password`
every request except `/healthz` needs HTTP Basic Auth; `auth_header` instead
requires an exact `Authorization` value. Without it: 401. Invalid combinations
answer 503 until fixed. HA integrations that fetch the image (e.g. a generic
camera or image URL) need the same username and password.

## Configuration

| Option (app) | Env (Docker) | Default | |
|---|---|---|---|
| `pages_dir` | `PAGES_DIR` | `/homeassistant/dashboard-pages` (app), `./pages` | Folder with pages |
| `render_timeout_ms` | `RENDER_TIMEOUT_MS` | `30000` | Maximum time for one render |
| `renderer_keep_alive` | `RENDERER_KEEP_ALIVE` | `0` | Seconds to keep the renderer process after a render and reuse it (0 to 86400). `0` starts a fresh process per render: lowest idle memory. Kept: faster renders, about 40–85 MB more memory while kept, depending on the pages; only helps if renders come more often than this. HA states are fetched on every render; the process is replaced only when the pages folder changes |
| `index_page` | `INDEX_PAGE` | `true` | Serve the page list at `/`; `false` or `0` answers 404 there |
| `auth_username` | `AUTH_USERNAME` | none | With the password: require HTTP Basic Auth on every request except `/healthz` |
| `auth_password` | `AUTH_PASSWORD` | none | Password for Basic Auth; set together with the username |
| `auth_header` | `AUTH_HEADER` | none | Instead of both: exact `Authorization` header value required, e.g. `Bearer <token>` |
| `ha_url` | `HA_URL` | Supervisor (app) | **Optional in the HA app**: leave empty to use the built-in connection. Required for standalone Docker: Home Assistant base URL |
| `ha_token` | `HA_TOKEN` | Supervisor (app) | **Optional in the HA app**: leave empty, no token needed. Required for standalone Docker: long-lived access token |

## Standalone Docker

```
docker run -p 8080:8080 -v "$PWD/pages:/app/pages:ro" -e HA_URL=https://ha.example.com -e HA_TOKEN=... ghcr.io/lordmike/hass-snapshotter
```

## Development

```
npm install
npm test
cp dev.env.example .tmp/dev.env   # fill in HA_URL and HA_TOKEN
node --env-file=.tmp/dev.env src/server.js
```

Releases: pushing a plain version tag (e.g. `0.4.0`, no `v`) builds and
publishes `ghcr.io/lordmike/hass-snapshotter` for amd64 and arm64, creates a
GitHub release and bumps the app in `LordMike/hass-addons`. The committed
`.env` holds only these Docker build settings; keep secrets in `.tmp/`.
