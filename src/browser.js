import puppeteer from "puppeteer-core";

// Flags trimmed for a single short-lived headless render on a small host.
const CHROMIUM_ARGS = [
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-breakpad",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-dev-shm-usage",
  "--disable-domain-reliability",
  "--disable-extensions",
  "--disable-features=Translate,MediaRouter,OptimizationHints",
  "--disable-renderer-backgrounding",
  "--disable-sync",
  "--hide-scrollbars",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-default-browser-check",
  "--no-first-run",
  "--no-sandbox",
  "--no-zygote",
  "--password-store=basic",
  "--use-mock-keychain",
  "--enable-low-end-device-mode",
];

/**
 * Owns at most one Chromium process. With idleSeconds = 0 the browser is
 * closed as soon as a render finishes, so nothing is held between renders.
 */
export class BrowserHost {
  constructor({ chromiumPath, idleSeconds }) {
    this.chromiumPath = chromiumPath;
    this.idleMs = Math.max(0, idleSeconds) * 1000;
    this.browser = null;
    this.idleTimer = null;
  }

  /** @returns {Promise<{browser: import("puppeteer-core").Browser, cold: boolean}>} */
  async acquire() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.browser?.connected) return { browser: this.browser, cold: false };

    this.browser = await puppeteer.launch({
      executablePath: this.chromiumPath,
      headless: "shell",
      args: CHROMIUM_ARGS,
      // Every launch gets a fresh temporary profile: no cache or state carries over.
      userDataDir: undefined,
    });
    this.browser.on("disconnected", () => {
      this.browser = null;
    });
    return { browser: this.browser, cold: true };
  }

  async release() {
    if (this.idleMs === 0) return this.close();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.idleMs);
  }

  async close() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const browser = this.browser;
    this.browser = null;
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        console.error("Error closing browser:", err.message);
        browser.process()?.kill("SIGKILL");
      }
    }
  }
}
