// A minimal stand-in for the frontend's `hass` object, backed by HA's REST API.
// `states` records which entities a page reads; only those are fetched.

// Areas and the entities in them (directly or through their device), as JSON.
const AREAS_TEMPLATE = `{%- set ns = namespace(out=[]) -%}
{%- for a in areas() -%}{%- set ns.out = ns.out + [[a, area_name(a), area_entities(a)]] -%}{%- endfor -%}
{{ ns.out | tojson }}`;

const fail = (status, message) => Object.assign(new Error(message), { status });

export class HassClient {
  constructor({ haBase, haToken }) {
    this.base = haBase;
    this.headers = { Authorization: `Bearer ${haToken}` };
    this.config = null;
    this.configFetched = 0;
  }

  async get(path, body) {
    const init = body ? { method: "POST", body: JSON.stringify(body) } : {};
    const res = await fetch(this.base + path, { ...init, headers: this.headers, signal: AbortSignal.timeout(10000) }).catch((err) => {
      throw fail(502, `Cannot reach Home Assistant at ${this.base}: ${err.cause?.message ?? err.message}`);
    });
    if (res.status === 401 || res.status === 403) {
      const redirect = res.redirected ? ` (${this.base} redirected to ${new URL(res.url).origin}; use that as the HA URL)` : "";
      throw fail(502, `Home Assistant rejected the token (${res.status})${redirect}${body ? " for " + path + ", which needs an admin user" : ""}. Check ha_token, or leave it empty in the app to use the built-in connection`);
    }
    // /api/template answers text/plain; its template writes JSON.
    if (!res.ok || !(body || res.headers.get("content-type")?.includes("json"))) {
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

  /**
   * Fills `into` with the states of `ids`; unknown entities become null. All
   * states are fetched in one request (about 1 MB for ~1000 entities), which
   * is much faster than one request per entity through the Supervisor proxy.
   */
  async fetchStates(ids, into) {
    this.all ??= new Map((await this.get("/api/states")).map((s) => [s.entity_id, s]));
    for (const id of ids) if (!(id in into)) into[id] = this.all.get(id) ?? null;
  }

  /** Areas and, per entity, its area (its own or its device's): one template request. */
  async fetchAreas() {
    const list = await this.get("/api/template", { template: AREAS_TEMPLATE });
    const areas = Object.create(null);
    const entities = Object.create(null);
    for (const [area_id, name, ids] of list) {
      areas[area_id] = Object.freeze({ area_id, name });
      for (const entity_id of ids) entities[entity_id] = Object.freeze({ entity_id, area_id });
    }
    return { areas: Object.freeze(areas), entities: Object.freeze(entities) };
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
