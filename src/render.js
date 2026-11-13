export class RenderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Runs inside the page. Returns null when the dashboard is fully ready,
// otherwise a short reason (reported if the wait times out).
function notReadyReason() {
  if (document.getElementById("ha-launch-screen")) return "launch screen visible";
  const ha = document.querySelector("home-assistant");
  const hass = ha?.hass;
  if (!hass) return "frontend not started";
  if (!hass.connected) return "websocket not connected";
  if (!hass.states || Object.keys(hass.states).length === 0) return "entity states not loaded";

  const resolver = ha.shadowRoot
    ?.querySelector("home-assistant-main")
    ?.shadowRoot?.querySelector("partial-panel-resolver");
  if (!resolver || resolver._loading) return "panel loading";
  const panel = resolver.children[0];
  if (!panel || panel._loading) return "panel content loading";
  if (panel._panelState && panel._panelState !== "loaded") return `dashboard ${panel._panelState}`;

  // Every custom element must be defined, and no card may be showing an
  // error card (Lovelace shows one while a custom card's JS is still loading).
  const roots = [document];
  while (roots.length) {
    for (const el of roots.pop().querySelectorAll("*")) {
      if (el.localName === "hui-error-card") return "a card is missing or errored";
      if (el.localName.includes("-") && !customElements.get(el.localName)) return `<${el.localName}> not defined`;
      if (el.shadowRoot) roots.push(el.shadowRoot);
    }
  }
  return null;
}

// Runs inside the page: hides toasts and returns where the dashboard content starts.
function prepareForScreenshot() {
  const ha = document.querySelector("home-assistant");
  const toast = ha?.shadowRoot?.querySelector("notification-manager");
  if (toast) toast.style.display = "none";
  const panel = ha?.shadowRoot
    ?.querySelector("home-assistant-main")
    ?.shadowRoot?.querySelector("partial-panel-resolver")?.children[0];
  const header = panel?.shadowRoot?.querySelector("hui-root")?.shadowRoot?.querySelector(".header");
  return Math.round(header?.getBoundingClientRect().bottom ?? 0);
}

async function waitForReady(page, config, deadline) {
  let reason = "not checked";
  while (Date.now() < deadline) {
    const url = new URL(page.url());
    if (url.origin !== config.haOrigin) {
      throw new RenderError(502, `Home Assistant redirected to ${url.origin}; set the HA URL to that origin`);
    }
    if (url.pathname.startsWith("/auth/")) {
      throw new RenderError(502, "Home Assistant redirected to login: the token is missing, invalid or expired");
    }
    reason = await page.evaluate(notReadyReason).catch((err) => `evaluate failed: ${err.message}`);
    if (reason === null) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new RenderError(504, `Dashboard not ready before the timeout: ${reason}`);
}

// The viewport is this much taller than requested, so a dashboard header fits above the crop.
const HEADER_ALLOWANCE = 56;

/**
 * Renders one HA path to a PNG screenshot.
 * @returns {Promise<{png: Buffer, timings: Record<string, number>, cold: boolean}>}
 */
export async function renderPage(host, config, req, more) {
  const timings = {};
  let last = Date.now();
  const mark = (name) => {
    const now = Date.now();
    timings[name] = now - last;
    last = now;
  };
  const deadline = last + req.timeoutMs;

  const { page, cold } = await host.acquire();
  mark("launch");
  try {
    await page.setViewport({ width: req.width, height: req.height + HEADER_ALLOWANCE });
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);

    // Log in by seeding the frontend's token store, and set language and theme
    // before the frontend starts so nothing re-renders after it is ready.
    const seed = {
      hassTokens: JSON.stringify({
        access_token: config.haToken,
        token_type: "Bearer",
        expires_in: 1800,
        hassUrl: config.haOrigin,
        clientId: config.haOrigin + "/",
        expires: 9999999999999,
        refresh_token: "",
      }),
      dockedSidebar: '"always_hidden"',
      selectedTheme: JSON.stringify({ theme: req.theme ?? "", dark: req.dark }),
      ...(req.lang && { selectedLanguage: JSON.stringify(req.lang) }),
    };
    const script = await page.evaluateOnNewDocument(
      (haOrigin, seed) => {
        if (location.origin !== haOrigin) return;
        for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
        // No service worker: avoids install traffic and "new version" toasts.
        delete Navigator.prototype.serviceWorker;
      },
      config.haOrigin,
      seed,
    );

    try {
      const response = await page.goto(req.url, { waitUntil: "domcontentloaded", timeout: deadline - Date.now() });
      if (!response?.ok()) {
        throw new RenderError(502, `Home Assistant returned ${response?.status() ?? "no response"} for ${req.url}`);
      }
    } finally {
      await page.removeScriptToEvaluateOnNewDocument(script.identifier).catch(() => {});
    }
    mark("navigate");

    await waitForReady(page, config, deadline);
    mark("ready");

    // Let late work finish (card modules, images, fonts). Bounded, because
    // camera and stream views never go idle. The websocket doesn't count.
    await page.waitForNetworkIdle({ idleTime: 250, timeout: Math.min(5000, deadline - Date.now()) }).catch(() => {});
    await waitForReady(page, config, deadline);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    const top = await page.evaluate(prepareForScreenshot);
    if (req.wait > 0) await new Promise((r) => setTimeout(r, Math.min(req.wait, deadline - Date.now())));
    mark("settle");

    const png = await page.screenshot({ type: "png", clip: { x: 0, y: top, width: req.width, height: req.height } });
    mark("screenshot");
    return { png, timings, cold };
  } finally {
    await host.release(page, more());
  }
}
