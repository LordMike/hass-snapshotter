// screen-30-5: entrance e-paper (800x480). Ported from the hass-vue page.
// The original is laid out at 960x680 and scaled non-uniformly to the screen; this
// port lays it out natively at 800x480 (no transform) so text stays crisp in 1-bit.
// render(hass, ctx) returns HTML; hass-snapshotter renders it to PNG.

export const size = [800, 480];

const TZ = "Europe/Copenhagen";

const WEATHER_ENTITY = "weather.openweathmap_hourly_with_local_data";

const CALENDARS = [
  { entity: "calendar.ical_michael", person: "Michael" },
  { entity: "calendar.ical_maria", person: "Maria" },
  { entity: "calendar.ical_aula_maila", person: "Maila" },
  { entity: "calendar.nemlig", person: "Nemlig" },
];

const TRAIN_SENSORS = ["sensor.hedehusene_st_to_hvalso_st", "sensor.hedehusene_st_to_valby_st"];

// The Vue page scans every sensor for affalddk attributes; without the full state
// list we name the affalddk sensors (minus the excluded "næste afhentning").
const GARBAGE_DEVICE = "ddbadb1e79d5d04f42e4f99461a236bf";
const GARBAGE_SENSORS = [
  "sensor.affalddk_asingsvej_8_farligt_affald",
  "sensor.affalddk_asingsvej_8_haveaffald",
  "sensor.affalddk_asingsvej_8_metal_glas",
  "sensor.affalddk_asingsvej_8_pap",
  "sensor.affalddk_asingsvej_8_papir_plast",
  "sensor.affalddk_asingsvej_8_rest_madaffald",
  "sensor.affalddk_asingsvej_8_storskrald",
];

// The Vue page scans every alert2.* entity. Here: alert2's own alerts plus every
// alert the alert2 generators report in their `generated_ids` attribute.
const ALERT2_STATIC = ["alert2.alert2_error", "alert2.alert2_global_exception", "alert2.alert2_warning"];
const ALERT2_GENERATORS = [
  "sensor.alert2generator_addon_running",
  "sensor.alert2generator_alertgen_pvbattery",
  "sensor.alert2generator_alertgen_softener_salt",
  "sensor.alert2generator_alertgen_yuka_mnn7bhzp_idle",
  "sensor.alert2generator_zwave_last_seen_stale",
];

const UV_CANDIDATES = [
  "sensor.uv_maks_i_dag",
  "sensor.openweathermap_daily_uv_index",
  "sensor.openweathermap_hourly_uv_index",
  "sensor.openweathermap_uv_index",
  "sensor.uv_index",
  "sensor.openweathmap_uv_index",
];

const WD_DA = ["Søn", "Man", "Tir", "Ons", "Tor", "Fre", "Lør"];
const MONTH_DA = ["Jan", "Feb", "Mar", "Apr", "Maj", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dec"];

export default function render(hass, { html, mdi, now }) {
  const s = (id) => hass.states[id];
  const stateOf = (id) => s(id)?.state;
  const attr = (id, a) => s(id)?.attributes?.[a];
  const friendly = (id) => attr(id, "friendly_name") || id;
  const icon = (name, size) => mdi(name, { size, color: "#000" });

  const n = local(now);
  const clock = `${pad(n.hour)}:${pad(n.minute)}`;

  // --- Weather header ---
  const weatherState = stateOf(WEATHER_ENTITY);
  const t = attr(WEATHER_ENTITY, "temperature");
  const weatherTemp = t == null ? "--" : `${Math.round(t)}°`;
  const weatherIcon =
    {
      "clear-night": "mdi:weather-night",
      sunny: "mdi:weather-sunny",
      cloudy: "mdi:weather-cloudy",
      partlycloudy: "mdi:weather-partly-cloudy",
      rainy: "mdi:weather-rainy",
      pouring: "mdi:weather-pouring",
      snowy: "mdi:weather-snowy",
      windy: "mdi:weather-windy",
      fog: "mdi:weather-fog",
    }[weatherState] || "mdi:weather-cloudy";

  // --- Open doors / windows / lights ---
  const expandGroupMembers = (groupId, seen = new Set()) => {
    if (seen.has(groupId)) return [];
    seen.add(groupId);
    const expanded = [];
    for (const id of attr(groupId, "entity_id") || []) {
      if (Array.isArray(attr(id, "entity_id"))) expanded.push(...expandGroupMembers(id, seen)); // nested group helper
      else expanded.push(id);
    }
    return expanded;
  };
  const isDoor = (id) => id.includes("door_") || attr(id, "device_class") === "door";
  const isWindow = (id) => id.includes("window_") || attr(id, "device_class") === "window";
  // No entity/device/area registry without the frontend, so this is the Vue fallback: the friendly name.
  const entityAreaName = (id) => friendly(id);
  const buildAreaStatusLines = (entities) => {
    const names = [...new Set(entities.map(entityAreaName))];
    if (names.length === 0) return ["", ""];
    if (names.length <= 2) return [names.join(", "), ""];
    const overflow = names.length - 3;
    return [`${names[0]}, ${names[1]}`, overflow > 0 ? `${names[2]} +${overflow} mere` : names[2]];
  };
  const activeGroupMembers = (groupId) => expandGroupMembers(groupId).filter((id) => stateOf(id) === "on");
  const openContacts = activeGroupMembers("binary_sensor.all_doors_windows");
  // Doors and windows share one cell; open doors are listed first and pick the icon.
  const doorsOpen = openContacts.filter(isDoor);
  const windowsOpen = openContacts.filter((id) => isWindow(id) && !isDoor(id));
  const openings = buildAreaStatusLines([...doorsOpen, ...windowsOpen]);
  const openingsIcon = doorsOpen.length ? "mdi:door-open" : windowsOpen.length ? "mdi:window-open" : "mdi:door-closed";
  const onLights = buildAreaStatusLines(activeGroupMembers("light.all_lights"));

  // --- EV3: away (not home), else locked / unlocked. An unknown location falls back to the lock. ---
  const ev3Where = stateOf("device_tracker.ev3_location");
  const ev3Lock = stateOf("lock.ev3_door_lock");
  const ev3Away = ev3Where !== undefined && !["home", "unknown", "unavailable"].includes(ev3Where);
  const ev3 = ev3Away
    ? { icon: "mdi:car-arrow-right", text: "Væk" }
    : ev3Lock === "locked"
      ? { icon: "mdi:lock-outline", text: "Låst" }
      : ev3Lock === "unlocked"
        ? { icon: "mdi:lock-open-variant-outline", text: "Ulåst" }
        : { icon: "mdi:car-electric-outline", text: "--" };
  const ev3Level = parseFloat(stateOf("sensor.ev3_ev_battery_level"));
  const ev3Charging = stateOf("binary_sensor.ev3_ev_battery_charge") === "on";
  const ev3Lines = [
    Number.isNaN(ev3Level) ? "EV3" : `EV3 ${Math.round(ev3Level)}%`,
    ev3Charging ? `${ev3.text}, lader` : ev3.text,
  ];

  // --- Calendar (each calendar entity exposes its next event only, as in the Vue page) ---
  const fmtTimeRange = (startIso, endIso, allDay) => {
    if (allDay) return "Hele dagen";
    if (!startIso) return "";
    const start = local(parseHaDate(startIso));
    const end = endIso ? local(parseHaDate(endIso)) : null;
    const hm = (d) => `${pad(d.hour)}:${pad(d.minute)}`;
    return end ? `${hm(start)} - ${hm(end)}` : hm(start);
  };
  const calendarEvents = [];
  for (const c of CALENDARS) {
    const st = s(c.entity);
    const start = st?.attributes?.start_time;
    if (!start) continue;
    calendarEvents.push({
      start: parseHaDate(start),
      startIso: start,
      endIso: st.attributes.end_time,
      allDay: st.attributes.all_day === true,
      title: st.attributes.message || friendly(c.entity),
      location: st.attributes.location || "",
      person: c.person,
    });
  }
  calendarEvents.sort((a, b) => a.start - b.start);
  const isToday = (d) => local(d).key === n.key;
  const todayEvents = calendarEvents.filter((e) => isToday(e.start)).slice(0, 4);
  const todayDateLabel = `${WD_DA[n.weekday].toLowerCase()}. ${n.day}. ${MONTH_DA[n.month].toLowerCase()}`;
  const upcomingEvents = calendarEvents
    .filter((e) => !isToday(e.start) && e.start > now)
    .slice(0, 3)
    .map((e) => {
      const d = local(e.start);
      return {
        ...e,
        dateLabel: `${WD_DA[d.weekday]} ${d.day} ${MONTH_DA[d.month]}`,
        timeLabel: e.allDay ? "Hele dagen" : `${pad(d.hour)}:${pad(d.minute)}`,
      };
    });

  // --- Transport ---
  const allConnections = TRAIN_SENSORS.flatMap((id) => attr(id, "connections") || []);
  allConnections.sort((a, b) => new Date(a.departure) - new Date(b.departure));
  const departures = allConnections.slice(0, 9).map((c) => {
    const dep = local(new Date(c.departure));
    const leg = (c.legs && c.legs[0]) || {};
    let note = c.transfers > 0 ? "Ikke direkte" : "Direkte";
    if (c.canceled) note = "Annulleret";
    return {
      time: c.canceled ? "Annulleret" : `${pad(dep.hour)}:${pad(dep.minute)}`,
      platform: leg.platform || "-",
      destination: c.destination || "",
      note,
    };
  });

  // --- Garbage ---
  const garbageIcon = (name) => {
    const lower = (name || "").toLowerCase();
    return lower.includes("mad") || lower.includes("have") || lower.includes("bio") ? "mdi:leaf" : "mdi:trash-can-outline";
  };
  const garbageItems = [];
  for (const id of GARBAGE_SENSORS) {
    const st = s(id);
    if (!st) continue;
    const dev = st.attributes?._device_id || st.attributes?.device_id;
    const looksLikeWaste = !!st.attributes?.date && !!st.attributes?.duration;
    if (dev !== GARBAGE_DEVICE && !looksLikeWaste) continue;
    const days = parseInt(st.state, 10);
    if (Number.isNaN(days)) continue;
    garbageItems.push({ id, days, name: st.attributes?.friendly_name || id, date: st.attributes?.date });
  }
  garbageItems.sort((a, b) => a.days - b.days);
  const garbagePickups = garbageItems.slice(0, 3).map((it) => ({
    ...it,
    icon: garbageIcon(it.name),
    dayLabel: it.days === 0 ? "i dag" : `${it.days}d ${it.date ? WD_DA[local(new Date(it.date)).weekday].toLowerCase() : ""}`,
  }));

  // --- Alerts ---
  const severityRank = (st) => {
    const priority = String(st.attributes?.priority || "").toLowerCase();
    const name = String(st.attributes?.name || st.attributes?.friendly_name || st.entity_id || "").toLowerCase();
    const text = `${priority} ${name}`;
    if (text.includes("critical") || text.includes("fatal")) return 5;
    if (text.includes("error")) return 4;
    if (text.includes("warning") || text.includes("warn")) return 3;
    if (text.includes("high")) return 3;
    if (text.includes("medium")) return 2;
    if (text.includes("low")) return 1;
    return 0;
  };
  const alertTime = (st) => {
    for (const value of [st.attributes?.last_on_time, st.attributes?.last_fired_time, st.attributes?.last_notified_time, st.state]) {
      const stamp = Date.parse(value);
      if (!Number.isNaN(stamp)) return stamp;
    }
    return 0;
  };
  const alertIds = [...new Set([...ALERT2_STATIC, ...ALERT2_GENERATORS.flatMap((id) => attr(id, "generated_ids") || [])])];
  const allAlerts = alertIds
    .map(s)
    .filter((st) => st && st.entity_id?.startsWith("alert2.") && st.state !== "off" && st.state !== "has never fired")
    .map((st) => ({
      severity: severityRank(st),
      time: alertTime(st),
      message: (st.attributes?.friendly_name || st.entity_id).replace(/^alert2[_.]?/i, "").replace(/_/g, " "),
    }))
    .sort((a, b) => b.severity - a.severity || b.time - a.time);
  const visibleAlerts = allAlerts.slice(0, 4);

  // --- Weather strip ---
  const rainV = parseFloat(stateOf("sensor.ihedeh8_daily_rain"));
  const dailyRain = Number.isNaN(rainV) ? null : rainV;
  const rainTitle = dailyRain && dailyRain > 0 ? "Regn i dag" : "Tørt i dag";
  const rainDetail = `${dailyRain ?? 0} mm regn`;

  const windV = parseFloat(stateOf("sensor.ihedeh8_wind_speed"));
  const windSpeed = Number.isNaN(windV) ? null : windV;
  const windTitle =
    windSpeed == null ? "Vind" : windSpeed < 3 ? "Stille" : windSpeed < 8 ? "Let vind" : windSpeed < 14 ? "Frisk vind" : windSpeed < 20 ? "Blæsende" : "Stormende";
  const windDetail =
    windSpeed == null ? "—" : windSpeed < 3 ? "Næsten vindstille" : windSpeed < 8 ? "Svag vind" : windSpeed < 14 ? "Frisk vind" : windSpeed < 20 ? "Hård vind" : "Storm";

  // --- Today's high/low: the daily forecast for today when it still lists it, otherwise
  // today's remaining hourly forecast plus the current temperature (misses an earlier low). ---
  const FORECAST = "input_text.weather_openweathermap_forecast";
  const isTodayEntry = (e) => e?.datetime && local(new Date(e.datetime)).key === n.key;
  const todayDaily = (attr(FORECAST, "forecast_daily") || []).find(isTodayEntry);
  const todayTemps = todayDaily
    ? [todayDaily.temperature, todayDaily.templow]
    : [t, ...(attr(FORECAST, "forecast_hourly") || []).filter(isTodayEntry).map((e) => e.temperature)];
  const temps = todayTemps.map(Number).filter(Number.isFinite);
  const tempHigh = temps.length ? `${Math.round(Math.max(...temps))}°` : "--";
  const tempLow = temps.length ? `${Math.round(Math.min(...temps))}°` : "--";

  let uvIndex = "—";
  for (const id of UV_CANDIDATES) {
    const v = parseFloat(stateOf(id));
    if (!Number.isNaN(v)) {
      uvIndex = Math.round(v * 10) / 10;
      break;
    }
  }

  const statusCell = (width, iconName, lines) => html`
    <div class="header-cell" style="width: ${width}px">
      <div class="cell-icon">${icon(iconName, 36)}</div>
      <div class="status-lines ${lines[1] ? "small" : ""}">${lines.map((name) => html`<div class="ellipsis">${name}</div>`)}</div>
    </div>`;

  return html`
    <style>
      .screen { position: relative; width: 800px; height: 480px; overflow: hidden; background: #fff; color: #000; font-family: Arial, Helvetica, sans-serif; }
      .dashboard { position: absolute; left: 0; top: 0; width: 800px; height: 480px; overflow: hidden; background: #fff; }
      .ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .narrow { font-family: "Arial Narrow", Arial, Helvetica, sans-serif; font-weight: 700; }

      .header { position: absolute; left: 7px; top: 0; width: 786px; height: 115px; border-bottom: 1px solid #000; overflow: hidden; }
      .header-row { position: absolute; left: 0; top: 29px; width: 786px; height: 69px; display: flex; }
      .header-cell { position: relative; height: 69px; border-left: 1px solid #000; display: flex; flex-direction: column; align-items: center; overflow: hidden; }
      .clock-cell { width: 230px; border-left: 0; }
      .clock { position: absolute; left: 22px; top: -10px; font-family: Arial, Helvetica, sans-serif; font-size: 72px; font-weight: 700; line-height: 72px; white-space: nowrap; }
      .clock-date { position: absolute; left: 26px; bottom: 0; font-size: 13px; line-height: 14px; white-space: nowrap; }
      .cell-icon { height: 39px; display: flex; align-items: center; justify-content: center; }
      .weather-top { height: 39px; width: 100%; display: flex; align-items: center; justify-content: center; }
      .weather-top svg { margin-right: 16px; }
      .weather-reading { font-size: 30px; line-height: 30px; }
      .weather-label { margin-top: 6px; font-size: 14px; line-height: 14px; max-width: 70px; }
      .status-lines { width: 100%; height: 30px; font-size: 13px; line-height: 15px; text-align: center; overflow: hidden; }
      .status-lines.small { font-size: 11px; line-height: 14px; }

      .mid-panels { position: absolute; left: 7px; top: 126px; width: 786px; height: 270px; display: flex; overflow: hidden; }
      .panel { position: relative; height: 270px; border: 1px solid #000; border-radius: 5px; overflow: hidden; padding: 10px 25px; }
      .panel-title { font-size: 15px; line-height: 15px; text-transform: uppercase; white-space: nowrap; }

      .calendar-panel { width: 313px; padding-left: 20px; padding-right: 12px; }
      .calendar-title-row { display: flex; justify-content: space-between; align-items: flex-start; }
      .calendar-today { margin-top: 9px; }
      .calendar-today.empty { height: 24px; display: flex; align-items: center; justify-content: center; }
      .calendar-empty { font-size: 13px; line-height: 13px; }
      .calendar-event { display: flex; flex-wrap: wrap; min-height: 39px; border-bottom: 1px solid #000; font-size: 13px; line-height: 13px; }
      .calendar-event.next { padding-top: 8px; }
      .calendar-time { width: 83px; margin-right: 5px; font-size: 12px; line-height: 13px; }
      .calendar-name { width: 191px; }
      .calendar-meta { margin-left: 88px; width: 191px; display: flex; align-items: center; margin-top: 7px; font-size: 11px; line-height: 11px; white-space: nowrap; }
      .calendar-meta .loc { width: 125px; margin-left: 4px; }
      .calendar-person { width: 48px; margin-left: 4px; text-align: right; }
      .upcoming-title { margin-top: 6px; margin-bottom: 6px; font-size: 13px; line-height: 13px; }
      .upcoming-row { display: flex; align-items: center; height: 15px; font-size: 11px; line-height: 11px; white-space: nowrap; }
      .u-date { width: 69px; }
      .u-time { width: 64px; }
      .u-title { flex: 1; }

      .transport-panel { width: 238px; margin-left: 9px; padding-left: 7px; padding-right: 13px; }
      .transport-table { margin-top: 14px; font-size: 12px; line-height: 12px; }
      .tr { display: flex; height: 23px; align-items: center; border-bottom: 1px solid #000; }
      .tr.head { height: 21px; align-items: flex-start; }
      .c1 { width: 49px; }
      .c2 { width: 37px; }
      .c3 { width: 74px; }
      .c4 { flex: 1; width: 56px; }

      .side-panel { width: 217px; margin-left: 9px; padding-left: 6px; padding-right: 20px; }
      .side-title-row { height: 17px; }
      .side-title-row .panel-title { font-size: 16px; line-height: 16px; }
      .garbage-list { margin-top: 6px; }
      .garbage-row { display: flex; align-items: center; height: 24px; border-bottom: 1px solid #000; }
      .garbage-icon { width: 22px; margin-right: 5px; display: flex; justify-content: center; }
      .garbage-name { flex: 1; font-size: 12px; line-height: 12px; }
      .garbage-day { width: 44px; margin-left: 5px; font-size: 11px; line-height: 11px; text-align: right; }
      .alerts-heading { display: flex; align-items: center; margin-top: 9px; height: 16px; }
      .alerts-heading .panel-title { flex: 1; }
      .alerts-count { width: 18px; font-size: 16px; line-height: 16px; }
      .alert-list { margin-top: 7px; }
      .alert-row { display: flex; align-items: center; height: 22px; border-bottom: 1px solid #000; font-size: 11px; line-height: 11px; white-space: nowrap; }
      .alert-row.last { border-bottom: 0; }
      .alert-icon { width: 20px; display: flex; }
      .alert-text { flex: 1; }

      .weather-strip { position: absolute; left: 7px; top: 405px; width: 786px; height: 55px; border: 1px solid #000; border-radius: 5px; display: flex; align-items: center; overflow: hidden; }
      .strip-item { height: 36px; display: flex; align-items: center; border-left: 1px solid #000; }
      .strip-item.first { border-left: 0; }
      .strip-icon { width: 70px; display: flex; justify-content: center; }
      .strip-copy { display: flex; flex-direction: column; font-size: 12px; line-height: 12px; overflow: hidden; white-space: nowrap; }
      .strip-copy .title { margin-bottom: 6px; }
      .uv-index { font-size: 28px; line-height: 28px; }
      .strip-temps { margin-left: auto; padding-right: 16px; display: flex; flex-direction: column; font-size: 15px; line-height: 18px; text-align: right; white-space: nowrap; }
    </style>
    <div class="screen">
      <div class="dashboard">
        <div class="header">
          <div class="header-row">
            <div class="header-cell clock-cell"><div class="clock">${clock}</div><div class="clock-date">${todayDateLabel}</div></div>
            <div class="header-cell" style="width: 140px">
              <div class="weather-top">${icon(weatherIcon, 46)}<div class="weather-reading">${weatherTemp}</div></div>
              <div class="weather-label ellipsis">Udendørs</div>
            </div>
            ${statusCell(160, openingsIcon, openings)}
            ${statusCell(156, "mdi:lightbulb-on-outline", onLights)}
            ${statusCell(100, ev3.icon, ev3Lines)}
          </div>
        </div>

        <div class="mid-panels">
          <div class="panel calendar-panel">
            <div class="calendar-title-row">
              <div class="panel-title narrow">I dag</div>
            </div>
            <div class="calendar-today ${todayEvents.length === 0 ? "empty" : ""}">
              ${todayEvents.length === 0 ? html`<div class="calendar-empty">ingen aftaler</div>` : ""}
              ${todayEvents.map(
                (ev, i) => html`
                  <div class="calendar-event ${i > 0 ? "next" : ""}">
                    <div class="calendar-time ellipsis">${fmtTimeRange(ev.startIso, ev.endIso, ev.allDay)}</div>
                    <div class="calendar-name ellipsis">${ev.title}</div>
                    <div class="calendar-meta">
                      ${icon("mdi:map-marker", 10)}
                      <div class="loc ellipsis">${ev.location}</div>
                      <div class="calendar-person ellipsis">${ev.person}</div>
                    </div>
                  </div>`,
              )}
            </div>
            <div class="upcoming-title narrow">KOMMENDE</div>
            ${upcomingEvents.map(
              (ev) => html`
                <div class="upcoming-row">
                  <div class="u-date ellipsis">${ev.dateLabel}</div>
                  <div class="u-time ellipsis">${ev.timeLabel}</div>
                  <div class="u-title ellipsis">${ev.title}</div>
                  <div class="calendar-person ellipsis">${ev.person}</div>
                </div>`,
            )}
          </div>

          <div class="panel transport-panel">
            <div class="panel-title narrow">Tog - Hedehusene St.</div>
            <div class="transport-table">
              <div class="tr head">
                <div class="c1 ellipsis">Tid</div><div class="c2 ellipsis">Spor</div><div class="c3 ellipsis">Destination</div><div class="c4 ellipsis">Bemærkning</div>
              </div>
              ${departures.map(
                (d) => html`
                  <div class="tr">
                    <div class="c1 ellipsis">${d.time}</div><div class="c2 ellipsis">${d.platform}</div><div class="c3 ellipsis">${d.destination}</div><div class="c4 ellipsis">${d.note}</div>
                  </div>`,
              )}
            </div>
          </div>

          <div class="panel side-panel">
            <div class="side-title-row"><div class="panel-title narrow">Affald</div></div>
            <div class="garbage-list">
              ${garbagePickups.map(
                (g) => html`
                  <div class="garbage-row">
                    <div class="garbage-icon">${icon(g.icon, 14)}</div>
                    <div class="garbage-name ellipsis">${g.name}</div>
                    <div class="garbage-day ellipsis">${g.dayLabel}</div>
                  </div>`,
              )}
            </div>
            <div class="alerts-heading">
              <div class="panel-title narrow">Advarsler</div>
              <div class="alerts-count">${allAlerts.length}</div>
              ${icon("mdi:alert", 16)}
            </div>
            <div class="alert-list">
              ${visibleAlerts.map(
                (a, i) => html`
                  <div class="alert-row ${i === visibleAlerts.length - 1 ? "last" : ""}">
                    <div class="alert-icon">${icon("mdi:alert", 13)}</div>
                    <div class="alert-text ellipsis">${a.message || a}</div>
                  </div>`,
              )}
            </div>
          </div>
        </div>

        <div class="weather-strip">
          <div class="strip-item first" style="width: 258px">
            <div class="strip-icon">${icon("mdi:weather-rainy", 34)}</div>
            <div class="strip-copy"><div class="title narrow">${rainTitle}</div><div>${rainDetail}</div></div>
          </div>
          <div class="strip-item" style="width: 233px">
            <div class="strip-icon">${icon("mdi:weather-windy", 34)}</div>
            <div class="strip-copy"><div class="title narrow">${windTitle}</div><div>${windDetail}</div></div>
            <div class="strip-temps"><div>↑ ${tempHigh}</div><div>↓ ${tempLow}</div></div>
          </div>
          <div class="strip-item" style="flex: 1">
            <div class="strip-icon">${icon("mdi:weather-sunny", 34)}</div>
            <div class="strip-copy" style="width: 82px"><div class="title narrow">UV-index</div><div>I dag (max)</div></div>
            <div class="uv-index">${uvIndex}</div>
          </div>
        </div>
      </div>
    </div>`;
}

// --- date helpers (Europe/Copenhagen; the container runs in UTC) ---

const pad = (v) => String(v).padStart(2, "0");

const localFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  weekday: "short",
  hourCycle: "h23",
});
const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Local calendar fields of `date` in Copenhagen (month 0-based, weekday 0 = Sunday). */
function local(date) {
  const p = Object.fromEntries(localFormat.formatToParts(date).map((x) => [x.type, x.value]));
  const year = Number(p.year);
  const month = Number(p.month) - 1;
  const day = Number(p.day);
  return {
    year,
    month,
    day,
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS_EN.indexOf(p.weekday),
    key: `${year}-${pad(month + 1)}-${pad(day)}`,
  };
}

/** HA calendar times come as "2026-12-21 00:00:00" (Copenhagen local) or ISO with offset. */
function parseHaDate(value) {
  const str = String(value);
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(str)) return new Date(str);
  const asUtc = new Date(str.replace(" ", "T") + "Z");
  if (Number.isNaN(asUtc.getTime())) return asUtc;
  // Shift by Copenhagen's offset at that moment (twice, to settle around DST changes).
  let guess = asUtc.getTime();
  for (let i = 0; i < 2; i++) {
    const l = local(new Date(guess));
    const offset = Date.UTC(l.year, l.month, l.day, l.hour, l.minute, l.second) - guess;
    guess = asUtc.getTime() - offset;
  }
  return new Date(guess);
}
