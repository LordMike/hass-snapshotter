export class RenderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Runs inside the page. Returns null when the dashboard is fully ready,
// otherwise a short reason string (reported if the wait times out).
function pageNotReadyReason() {
  const ha = document.querySelector("home-assistant");
  if (!ha) return "home-assistant element missing";
  const hass = ha.hass;
  if (!hass) return "hass object not set";
  if (!hass.connected) return "websocket not connected";
  if (!hass.states || Object.keys(hass.states).length === 0) return "entity states not loaded";

  const main = ha.shadowRoot?.querySelector("home-assistant-main");
  if (!main) return "home-assistant-main missing";
  const resolver = main.shadowRoot?.querySelector("partial-panel-resolver");
  if (!resolver) return "panel resolver missing";
  if (resolver._loading) return "panel loading";
  const panel = resolver.children[0];
  if (!panel) return "panel missing";
  if ("_loading" in panel && panel._loading) return "panel content loading";

  // Every custom element anywhere in the page (including shadow roots) must be
  // defined. An undefined element is a card whose JS has not loaded yet.
  const roots = [document];
  while (roots.length) {
    const root = roots.pop();
    for (const el of root.querySelectorAll("*")) {
      if (el.localName.includes("-") && !customElements.get(el.localName)) {
        return `custom element <${el.localName}> not defined`;
      }
      if (el.shadowRoot) roots.push(el.shadowRoot);
    }
  }
  return null;
}

async function waitForReady(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let reason = "not checked";
  while (Date.now() < deadline) {
    if (new URL(page.url()).pathname.startsWith("/auth/")) {
      throw new RenderError(502, "Home Assistant redirected to login: the token is missing, invalid or expired");
    }
    reason = await page.evaluate(pageNotReadyReason).catch((err) => `evaluate failed: ${err.message}`);
    if (reason === null) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new RenderError(504, `Dashboard not ready after ${timeoutMs} ms: ${reason}`);
}

/**
 * Renders one HA path to a PNG screenshot.
 * @returns {Promise<{png: Buffer, timings: Record<string, number>, cold: boolean}>}
 */
export async function renderPage(host, config, req) {
  const t = { start: Date.now() };
  const mark = (name) => (t[name] = Date.now());
  const deadline = t.start + req.timeoutMs;
  const remaining = () => Math.max(1000, deadline - Date.now());

  const { browser, cold } = await host.acquire();
  mark("launch");
  let page;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: req.width, height: req.height + config.headerHeight });
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    page.on("pageerror", (err) => console.log(`  page error: ${err.message}`));

    // Never let the top-level page navigate away from Home Assistant.
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        const origin = new URL(request.url()).origin;
        if (origin !== config.haOrigin) {
          console.log(`  blocked navigation to ${origin}`);
          return request.abort("blockedbyclient");
        }
      }
      return request.continue();
    });

    // Log in by seeding the frontend's token store. The script only writes on
    // the HA origin, so the token never reaches another site's storage.
    const tokens = JSON.stringify({
      access_token: config.haToken,
      token_type: "Bearer",
      expires_in: 1800,
      hassUrl: config.haOrigin,
      clientId: config.haOrigin + "/",
      expires: 9999999999999,
      refresh_token: "",
    });
    await page.evaluateOnNewDocument(
      (haOrigin, tokens, dark) => {
        if (location.origin !== haOrigin) return;
        localStorage.setItem("hassTokens", tokens);
        localStorage.setItem("dockedSidebar", '"always_hidden"');
        localStorage.setItem("selectedTheme", JSON.stringify({ dark }));
      },
      config.haOrigin,
      tokens,
      req.dark,
    );

    const response = await page.goto(req.url, { waitUntil: "domcontentloaded", timeout: remaining() });
    if (!response?.ok()) {
      throw new RenderError(502, `Home Assistant returned ${response?.status() ?? "no response"} for ${req.url}`);
    }
    mark("navigate");

    await waitForReady(page, remaining());
    mark("ready");

    if (req.lang) {
      await page.evaluate((lang) => document.querySelector("home-assistant")._selectLanguage(lang, false), req.lang);
    }
    if (req.theme) {
      await page.evaluate(
        (theme, dark) =>
          document.querySelector("home-assistant").dispatchEvent(new CustomEvent("settheme", { detail: { theme, dark } })),
        req.theme,
        req.dark,
      );
    }

    // Let lazy work finish: card modules, images, translations, fonts. The HA
    // websocket is not an HTTP request, so it does not keep the network busy.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: remaining() }).catch(() => {
      throw new RenderError(504, "Network did not go idle before the timeout");
    });
    await waitForReady(page, remaining());
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    if (req.wait > 0) await new Promise((r) => setTimeout(r, Math.min(req.wait, remaining())));
    mark("settle");

    const png = await page.screenshot({
      type: "png",
      clip: { x: 0, y: config.headerHeight, width: req.width, height: req.height },
    });
    mark("screenshot");

    return { png, timings: toDurations(t), cold };
  } finally {
    await page?.close().catch(() => {});
    await host.release();
  }
}

function toDurations(t) {
  const order = ["launch", "navigate", "ready", "settle", "screenshot"];
  const out = {};
  let prev = t.start;
  for (const name of order) {
    if (t[name] === undefined) continue;
    out[name] = t[name] - prev;
    prev = t[name];
  }
  return out;
}
