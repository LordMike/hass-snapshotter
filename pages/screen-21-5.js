// screen-21-5: bathroom e-paper (800x480, 6 colours). Ported from the hass-vue page.
// render(hass, ctx) returns HTML; hass-snapshotter renders it to PNG.

export const size = [800, 480];

const ENTITIES = {
  time1Start: "sensor.wattplan_hvidevarer_option_1_start",
  time2Start: "sensor.wattplan_hvidevarer_12h_option_1_start",
  time2FallbackStart: "sensor.wattplan_hvidevarer_12h_option_2_start",
  optionWindows: [
    "sensor.wattplan_hvidevarer_option_1_start",
    "sensor.wattplan_hvidevarer_option_2_start",
    "sensor.wattplan_hvidevarer_12h_option_1_start",
    "sensor.wattplan_hvidevarer_12h_option_2_start",
  ],
  prices: "sensor.stromligning_today_prices_15min",
  pv: "sensor.energy_production_today",
  battery: "sensor.screen_21_5_battery_level",
  nextUpdate: "input_datetime.screen_21_5_nextupdate",
  weatherForecast: "input_text.weather_openweathermap_forecast",
  yMin: "input_number.screen_21_5_graph_y_min_bound",
  yMax: "input_number.screen_21_5_graph_y_max_bound",
  topN: "input_number.screen_21_5_graph_top_n_count",
  bottomN: "input_number.screen_21_5_graph_bottom_n_count",
};

const TZ = "Europe/Copenhagen";
const SLOT_COUNT = 96;
const SLOT_MINUTES = (24 * 60) / SLOT_COUNT;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEATHER_START_HOUR = 8;
const WEATHER_END_HOUR = 16;
const WEATHER_TOMORROW_SWITCH_HOUR = 15;
const UV_WARNING_THRESHOLD = 3;
const RAIN_SIGNIFICANT_MM = 0.5;
const CHART = { width: 758, height: 170, leftPad: 44, rightPad: 8, laneTop: 2, laneHeight: 10, topPad: 16, plotHeight: 148 };

export default function render(hass, { html, raw, now }) {
  const entity = (id) => hass.states[id];
  const state = (id) => entity(id)?.state;
  const attr = (id, name) => entity(id)?.attributes?.[name];
  const todayKey = localDateKey(now);

  // Times
  const startDate = (id) => new Date(state(id));
  const time1Start = startDate(ENTITIES.time1Start);
  let time2Start = startDate(ENTITIES.time2Start);
  // Both loads often pick the same cheapest slot; show the 12h load's second option instead.
  if (time2Start.getTime() === time1Start.getTime()) time2Start = startDate(ENTITIES.time2FallbackStart);
  const formatFutureStart = (date) => {
    if (Number.isNaN(date.getTime())) return "--:--";
    const time = formatTime(date, false);
    return localDateKey(date) === todayKey ? time : `${localWeekdayShort(date)} ${time}`;
  };

  const todaySlot = (date) => {
    const dayOffset = (Date.parse(localDateKey(date)) - Date.parse(todayKey)) / DAY_MS;
    return dayOffset * SLOT_COUNT + Math.floor((localHour(date) * 60 + localMinute(date)) / SLOT_MINUTES);
  };
  const optionSlots = ENTITIES.optionWindows
    .map((id) => ({ start: startDate(id), end: new Date(attr(id, "end_timestamp")) }))
    .filter(({ start, end }) => !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()))
    .map(({ start, end }) => ({ start: todaySlot(start), end: todaySlot(end) }));

  // Prices
  const attrPrices = attr(ENTITIES.prices, "prices");
  const rawPrices = Array.isArray(attrPrices)
    ? attrPrices
    : parseNumbers(typeof attrPrices === "string" ? attrPrices : state(ENTITIES.prices));
  const prices = rawPrices.map(Number).filter(Number.isFinite).slice(0, SLOT_COUNT);
  while (prices.length < SLOT_COUNT) prices.push(0);

  const pv = asNumber(state(ENTITIES.pv), NaN);
  const pvLabel = Number.isFinite(pv) ? `Sol estimeret: ${pv.toFixed(1)} kWh` : "Sol estimeret: -- kWh";
  const battery = asNumber(state(ENTITIES.battery), NaN);
  const batteryLabel = Number.isFinite(battery) ? `Batteri: ${Math.round(battery)}%` : "Batteri: --%";

  // Weather: today 08-16, or tomorrow after 15:00
  const weatherDate = localHour(now) < WEATHER_TOMORROW_SWITCH_HOUR ? now : new Date(now.getTime() + DAY_MS);
  const weatherIsToday = localDateKey(weatherDate) === todayKey;
  const forecast = attr(ENTITIES.weatherForecast, "forecast_hourly");
  const weatherWindow = (Array.isArray(forecast) ? forecast : [])
    .map((entry) => ({ entry, date: parseDate(entry?.datetime) }))
    .filter(({ date }) => date && localDateKey(date) === localDateKey(weatherDate))
    .filter(({ date }) => localHour(date) >= WEATHER_START_HOUR && localHour(date) < WEATHER_END_HOUR)
    .sort((a, b) => a.date - b.date);

  const hours = weatherWindow.map(({ date }) => localHour(date));
  const range = hours.length ? { start: Math.min(...hours), end: Math.min(WEATHER_END_HOUR, Math.max(...hours) + 1) } : null;
  const weatherTitle = `Vejrudsigt ${weatherIsToday ? "i dag" : localWeekdayShort(weatherDate)} kl. ${
    range ? `${formatHour(range.start)} - ${formatHour(range.end)}` : "--"
  }`;

  const temps = weatherWindow
    .map(({ entry }) => readFirstNumber(entry, ["temperature", "native_temperature", "temp"]))
    .filter(Number.isFinite);
  const tMin = Math.round(Math.min(...temps));
  const tMax = Math.round(Math.max(...temps));
  const tempLabel = temps.length ? (tMin === tMax ? `${tMin}°C` : `${tMin}-${tMax}°C`) : "--";

  const rain = weatherWindow.map(({ entry }) => readPrecipitationMm(entry)).filter(Number.isFinite);
  const rainTotal = rain.length ? rain.reduce((sum, v) => sum + Math.max(0, v), 0) : NaN;
  const rainLabel = Number.isFinite(rainTotal) ? `${formatNumber(rainTotal, 1)} mm` : "-- mm";
  const rainWarning = Number.isFinite(rainTotal) && rainTotal >= RAIN_SIGNIFICANT_MM;

  const uvs = weatherWindow.map(({ entry }) => asNumber(entry?.uv_index, NaN)).filter(Number.isFinite);
  const uv = uvs.length ? Math.max(...uvs) : NaN;
  const uvLabel = Number.isFinite(uv) ? `UV: ${uv.toFixed(1)}` : "UV: --";
  const uvWarning = Number.isFinite(uv) && uv >= UV_WARNING_THRESHOLD;

  // Chart
  const settings = {
    yMinBound: clamp(Math.round(asNumber(state(ENTITIES.yMin), 0)), -10, 10),
    yMaxBound: clamp(Math.round(asNumber(state(ENTITIES.yMax), 2)), 0, 20),
    topN: clamp(Math.round(asNumber(state(ENTITIES.topN), 10)), 0, SLOT_COUNT),
    bottomN: clamp(Math.round(asNumber(state(ENTITIES.bottomN), 10)), 0, SLOT_COUNT),
  };
  const chart = priceChart(prices, settings, optionSlots);

  return html`
    <style>
      .screen { position: relative; width: 800px; height: 480px; overflow: hidden; background: #fff; color: #000; font-family: Roboto; }
      .top-bar { position: absolute; left: 0; top: 0; width: 800px; height: 70px; background: #f00; }
      .date { position: absolute; left: 16px; top: 14px; color: #fff; font-size: 34px; line-height: 42px; white-space: nowrap; }
      .times-row { position: absolute; left: 16px; top: 86px; width: 768px; height: 130px; display: grid; grid-template-columns: 1fr 1fr 2fr; column-gap: 10px; }
      .card { position: relative; height: 130px; background: #fff; border: 2px solid #000; }
      .card-header { position: absolute; left: 0; top: 0; width: 100%; height: 56px; display: flex; align-items: center; justify-content: center; }
      .card-header.time { background: #ff0; font-size: 26px; line-height: 32px; }
      .card-header.weather { background: #00f; color: #fff; font-size: 18px; line-height: 24px; }
      .time-value { position: absolute; left: 0; top: 68px; width: 100%; text-align: center; font-size: 30px; line-height: 38px; white-space: nowrap; }
      .weather-values { position: absolute; left: 16px; right: 10px; top: 58px; bottom: 0; display: flex; align-items: center; justify-content: space-between; white-space: nowrap; }
      .weather-row { display: flex; height: 34px; align-items: center; font-size: 28px; line-height: 34px; }
      .weather-label { width: 96px; margin-right: 10px; text-align: right; }
      .weather-uv { font-size: 24px; line-height: 34px; padding: 4px 8px; }
      .warning { background: #ff0; border: 2px solid #000; }
      .graph-row { position: absolute; left: 16px; top: 224px; width: 768px; height: 230px; background: #fff; border: 2px solid #000; }
      .graph-header { position: absolute; left: 0; top: 0; width: 100%; height: 36px; background: #00f; color: #fff; }
      .graph-title { position: absolute; left: 12px; top: 2px; font-size: 26px; line-height: 32px; white-space: nowrap; }
      .pv { position: absolute; right: 12px; top: 5px; font-size: 22px; line-height: 26px; white-space: nowrap; }
      .chart { position: absolute; left: 5px; top: 40px; }
      .abs { position: absolute; white-space: nowrap; }
      .axis { left: 6px; font-size: 22px; line-height: 26px; }
      .small { font-size: 12px; line-height: 16px; }
      .bottom-bar { position: absolute; left: 0; top: 454px; width: 800px; height: 26px; display: flex; align-items: center; font-size: 12px; line-height: 26px; white-space: nowrap; }
      .bottom-bar span { flex: 1; }
    </style>
    <div class="screen">
      <div class="top-bar"><div class="date">${formatDanishPageDate(now)}</div></div>

      <div class="times-row">
        <div class="card"><div class="card-header time">Tid 1</div><div class="time-value">${formatFutureStart(time1Start)}</div></div>
        <div class="card"><div class="card-header time">Tid 2</div><div class="time-value">${formatFutureStart(time2Start)}</div></div>
        <div class="card">
          <div class="card-header weather">${weatherTitle}</div>
          <div class="weather-values">
            <div>
              <div class="weather-row"><span class="weather-label">Temp:</span><span>${tempLabel}</span></div>
              <div class="weather-row"><span class="weather-label">Regn:</span><span class="${rainWarning ? "warning" : ""}">${rainLabel}</span></div>
            </div>
            <div class="weather-uv ${uvWarning ? "warning" : ""}">${uvLabel}</div>
          </div>
        </div>
      </div>

      <div class="graph-row">
        <div class="graph-header"><div class="graph-title">Strømpriser i dag</div><div class="pv">${pvLabel}</div></div>
        <div class="chart">${chart.svg}</div>
        <div class="abs axis" style="top: 56px">${chart.yMax}</div>
        <div class="abs axis" style="top: 196px">${chart.yMin}</div>
        <div class="abs small" style="left: 6px; top: 120px">DKK</div>
        ${[["00:00", 44], ["06:00", 223], ["12:00", 402], ["18:00", 581], ["24", 738]].map(
          ([label, left]) => html`<div class="abs small" style="left: ${left}px; top: 212px">${label}</div>`,
        )}
      </div>

      <div class="bottom-bar">
        <span style="padding-left: 8px">Sidst opdateret: ${formatTime(now, true)}</span>
        <span style="text-align: center">Næste opdatering: ${formatInputDateTime(entity(ENTITIES.nextUpdate))}</span>
        <span style="padding-right: 8px; text-align: right">${batteryLabel}</span>
      </div>
    </div>`;

  function priceChart(values, settings, optionSlots) {
    const { width, leftPad, rightPad, topPad, plotHeight: plotH } = CHART;
    let yMin = Math.floor(Math.min(...values, settings.yMinBound));
    let yMax = Math.ceil(Math.max(...values, settings.yMaxBound));
    if (yMax <= yMin) yMax = yMin + 1;

    const sorted = values.slice().sort((a, b) => a - b);
    const lowCut = settings.bottomN > 0 ? sorted[settings.bottomN - 1] : 0;
    const highCut = settings.topN > 0 ? sorted[SLOT_COUNT - settings.topN] : 0;
    const plotW = width - leftPad - rightPad;
    const yOf = (v) => topPad + plotH - Math.round(clamp((v - yMin) / (yMax - yMin), 0, 1) * plotH);
    const zeroY = clamp(yOf(0), topPad, topPad + plotH - 1);

    const rects = [];
    for (let v = yMin; v <= yMax; v++) rects.push(`<rect x="${leftPad}" y="${yOf(v)}" width="${plotW}" height="2" fill="#f00"/>`);
    values.forEach((value, i) => {
      const x1 = leftPad + Math.floor((i * plotW) / SLOT_COUNT);
      const x2 = Math.max(x1, leftPad + Math.floor(((i + 1) * plotW) / SLOT_COUNT) - 2);
      const y = yOf(value);
      const fill = settings.topN > 0 && value > highCut ? "#f00" : settings.bottomN > 0 && value < lowCut ? "#00f" : "#000";
      rects.push(`<rect x="${x1}" y="${Math.min(y, zeroY)}" width="${x2 - x1 + 1}" height="${Math.abs(y - zeroY) + 1}" fill="${fill}"/>`);
    });
    // Option windows share the bar x-scale, so each block sits exactly over its slots.
    for (const slots of optionSlots) {
      const from = clamp(slots.start, 0, SLOT_COUNT);
      const to = clamp(slots.end, 0, SLOT_COUNT);
      if (to <= from) continue;
      const x1 = leftPad + Math.floor((from * plotW) / SLOT_COUNT);
      const x2 = leftPad + Math.floor((to * plotW) / SLOT_COUNT) - 2;
      rects.push(`<rect x="${x1}" y="${CHART.laneTop}" width="${x2 - x1 + 1}" height="${CHART.laneHeight}" fill="#000"/>`);
    }
    const svg = raw(
      `<svg width="${CHART.width}" height="${CHART.height}" viewBox="0 0 ${CHART.width} ${CHART.height}" shape-rendering="crispEdges">${rects.join("")}</svg>`,
    );
    return { svg, yMin: String(yMin), yMax: String(yMax) };
  }
}

// --- formatting helpers (Europe/Copenhagen, Danish) ---

// Formatters are created once; building one per call dominated template time.
const dtf = (options) => new Intl.DateTimeFormat("da-DK", { timeZone: TZ, ...options });
const PARTS = dtf({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const PAGE_DATE = dtf({ weekday: "long", day: "numeric", month: "long" });
const WEEKDAY_SHORT = dtf({ weekday: "short" });
const TIME = dtf({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const TIME_SECONDS = dtf({ hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

const local = (date) => Object.fromEntries(PARTS.formatToParts(date).map((p) => [p.type, p.value]));
function localDateKey(date) {
  const p = local(date);
  return `${p.year}-${p.month}-${p.day}`;
}
const localHour = (date) => Number(local(date).hour);
const localMinute = (date) => Number(local(date).minute);

function formatDanishPageDate(date) {
  const p = Object.fromEntries(PAGE_DATE.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.weekday.charAt(0).toUpperCase() + p.weekday.slice(1)} ${p.day}. ${p.month}`;
}

const localWeekdayShort = (date) => WEEKDAY_SHORT.format(date).replace(".", "").toLowerCase();
const formatTime = (date, seconds) => (seconds ? TIME_SECONDS : TIME).format(date);

function formatInputDateTime(s) {
  if (!s) return "--:--";
  // For a time-only input_datetime, `timestamp` is seconds since midnight, not an instant.
  const ts = s.attributes?.has_date === false ? NaN : asNumber(s.attributes?.timestamp, NaN);
  if (Number.isFinite(ts)) return formatTime(new Date(ts * 1000), false);
  const m = /(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s.state || "");
  return m ? `${pad2(m[1])}:${pad2(m[2])}` : "--:--";
}

const formatHour = (h) => `${pad2(h)}:00`;
const pad2 = (v) => String(v).padStart(2, "0");
const formatNumber = (v, digits) => v.toLocaleString("da-DK", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const parseNumbers = (raw) => (raw ? String(raw).split(/[,\s;|]+/).map(Number) : []);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseDate(raw) {
  if (typeof raw !== "string" || !raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function readFirstNumber(source, names) {
  for (const name of names) {
    const v = asNumber(source?.[name], NaN);
    if (Number.isFinite(v)) return v;
  }
  return NaN;
}

function readPrecipitationMm(source) {
  const direct = readFirstNumber(source, ["precipitation", "native_precipitation", "rain", "rain_mm", "rainMm", "rain_1h", "rain1h", "precipitation_mm", "precipitationMm"]);
  return Number.isFinite(direct) ? direct : readFirstNumber(source?.rain, ["1h", "3h", "mm"]);
}
