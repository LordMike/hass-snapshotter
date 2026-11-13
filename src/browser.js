import { rmSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

// Puppeteer's defaults already cover background/sync/extension flags.
const ARGS = [
  "--no-sandbox",
  "--no-zygote",
  "--enable-low-end-device-mode",
  "--renderer-process-limit=1",
  "--disable-features=IsolateOrigins,site-per-process",
  "--disk-cache-size=67108864",
];

/**
 * Owns at most one Chromium process. With idleSeconds = 0 the browser is
 * closed once no render is in progress or queued.
 */
export class BrowserHost {
  constructor({ chromiumPath, idleSeconds, profileDir }) {
    this.chromiumPath = chromiumPath;
    this.idleMs = Math.max(0, idleSeconds) * 1000;
    this.profileDir = profileDir;
    this.browser = null;
    this.idleTimer = null;
  }

  /** @returns {Promise<{page: import("puppeteer-core").Page, cold: boolean}>} */
  async acquire() {
    clearTimeout(this.idleTimer);
    let cold = false;
    if (!this.browser?.connected) {
      // A killed browser leaves its profile lock behind.
      for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
        rmSync(join(this.profileDir, f), { force: true });
      }
      this.browser = await puppeteer.launch({
        executablePath: this.chromiumPath,
        headless: "shell",
        pipe: true,
        userDataDir: this.profileDir,
        args: ARGS,
      });
      cold = true;
    }
    // Reuse the initial tab rather than opening a second renderer.
    const [page] = await this.browser.pages();
    return { page: page ?? (await this.browser.newPage()), cold };
  }

  /** @param {boolean} more another render is queued right behind this one */
  async release(page, more) {
    if (more) return;
    if (this.idleMs === 0) return this.close();
    await page.goto("about:blank").catch(() => {});
    this.idleTimer = setTimeout(() => this.close(), this.idleMs);
  }

  async close() {
    clearTimeout(this.idleTimer);
    const browser = this.browser;
    this.browser = null;
    if (!browser) return;
    await browser.close().catch((err) => {
      console.error("Error closing browser:", err.message);
      browser.process()?.kill("SIGKILL");
    });
  }
}
