// A minimal stand-in for the frontend's `hass` object, backed by HA's REST API.
// `states` records which entities a page reads; only those are fetched.

const fail = (status, message) => Object.assign(new Error(message), { status });

export class HassClient {
  constructor({ haBase, haToken }) {
    this.base = haBase;
    this.headers = { Authorization: `Bearer ${haToken}` };
    this.config = null;
    this.configFetched = 0;
  }

  async get(path) {
    const res = await fetch(this.base + path, { headers: this.headers, signal: AbortSignal.timeout(10000) }).catch((err) => {
      throw fail(502, `Cannot reach Home Assistant at ${this.base}: ${err.cause?.message ?? err.message}`);
    });
    if (res.status === 404 && path.startsWith("/api/states/")) return null; // unknown entity
    if (res.status === 401 || res.status === 403) {
      const redirect = res.redirected ? ` (${this.base} redirected to ${new URL(res.url).origin}; use that as the HA URL)` : "";
      throw fail(502, `Home Assistant rejected the token (${res.status})${redirect}. Check ha_token, or leave it empty in the app to use the built-in connection`);
    }
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) {
      throw fail(502, `${this.base}${path} returned ${res.status} ${res.headers.get("content-type") ?? ""}; is the HA URL the base URL of Home Assistant?`);
    }
    return res.json();
  }

  async getConfig() {
    if (!this.config || Date.now() - this.configFetched > 3600_000) {
      this.config = await this.get("/api/config");
      this.configFetched = Date.now();
    }
    return this.config;
  }

  /** Fetches states for ids not already in `into`. Unknown entities become null. */
  async fetchStates(ids, into) {
    const todo = [...ids].filter((id) => !(id in into));
    const results = await Promise.all(todo.map((id) => this.get(`/api/states/${encodeURIComponent(id)}`)));
    todo.forEach((id, i) => (into[id] = results[i]));
  }
}

/**
 * A `states` object over what has been fetched. Every read is recorded in
 * `read`; reads of entities not fetched yet are also recorded in `missing`.
 * Unfetched and unknown entities read as undefined.
 */
export function recordingStates(fetched, missing, read) {
  return new Proxy(fetched, {
    get(target, id) {
      if (typeof id !== "string") return undefined;
      read.add(id);
      if (!(id in target)) missing.add(id);
      return target[id] ?? undefined;
    },
    has(target, id) {
      if (typeof id !== "string") return false;
      read.add(id);
      if (!(id in target)) missing.add(id);
      return target[id] != null;
    },
  });
}
