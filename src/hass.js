// A minimal stand-in for the frontend's `hass` object, backed by HA's REST API.
// `states` records which entities a page reads; only those are fetched.

export class HassClient {
  constructor({ haOrigin, haToken }) {
    this.origin = haOrigin;
    this.headers = { Authorization: `Bearer ${haToken}`, "Content-Type": "application/json" };
    this.config = null;
    this.configFetched = 0;
  }

  async get(path) {
    const res = await fetch(this.origin + path, { headers: this.headers, signal: AbortSignal.timeout(10000) }).catch((err) => {
      throw Object.assign(new Error(`Cannot reach HA at ${this.origin}: ${err.cause?.message ?? err.message}`), { status: 502 });
    });
    if (res.status === 404) return null;
    if (res.status === 401) throw Object.assign(new Error("HA rejected the token (401)"), { status: 502 });
    if (!res.ok) throw Object.assign(new Error(`HA ${path} returned ${res.status}`), { status: 502 });
    return res.json();
  }

  async getConfig() {
    if (!this.config || Date.now() - this.configFetched > 3600_000) {
      this.config = await this.get("/api/config");
      this.configFetched = Date.now();
    }
    return this.config;
  }

  /** Fetches states for ids not already in `into`. Missing entities become null. */
  async fetchStates(ids, into) {
    const todo = [...ids].filter((id) => !(id in into));
    const results = await Promise.all(todo.map((id) => this.get(`/api/states/${encodeURIComponent(id)}`)));
    todo.forEach((id, i) => (into[id] = results[i]));
  }
}

/**
 * A `states` object that returns what has been fetched and records reads of
 * anything not fetched yet. Unfetched and unknown entities read as undefined.
 */
export function recordingStates(fetched, missing) {
  return new Proxy(fetched, {
    get(target, id) {
      if (typeof id !== "string") return undefined;
      if (!(id in target)) missing.add(id);
      return target[id] ?? undefined;
    },
    has(target, id) {
      if (!(id in target)) missing.add(id);
      return target[id] != null;
    },
  });
}
