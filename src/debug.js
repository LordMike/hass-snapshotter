// /page/<name>.debug: the request's verbose log with times since the request
// started, warnings, the error if any, and the rendered image.
import { html } from "./html.js";

const ms = (n) => n.toFixed(1);

export function debugPage({ name, query, palettes, trace, result, error }) {
  const rows = [];
  let prev = trace.start;
  // Arrival order is the true order; the two processes' clocks can differ by a fraction of a ms.
  for (const e of trace.entries) {
    rows.push(html`<tr class="${e.level}"><td>${ms(e.t - trace.start)}</td><td>+${ms(Math.max(0, e.t - prev))}</td><td>${e.text}</td></tr>`);
    prev = e.t;
  }
  const total = prev - trace.start;

  // Links keep the page's own parameters; `palette` is swapped per link.
  const params = new URLSearchParams(query);
  params.delete("palette");
  const link = (suffix, palette) => {
    const q = new URLSearchParams(params);
    if (palette) q.set("palette", palette);
    return `${name}${suffix}${q.size ? "?" + q : ""}`;
  };
  const current = query.get("palette");
  const variants = [null, ...palettes].map((p) =>
    p === current || (!p && !current) ? html`<b>${p ?? "full color"}</b>` : html`<a href="${link(".debug", p)}">${p ?? "full color"}</a>`,
  );
  const warnings = result?.warnings ?? [];

  return String(html`<!doctype html><meta charset="utf-8"><title>${name} · debug</title>
<style>
body { font: 14px system-ui, sans-serif; margin: 16px; }
table { border-collapse: collapse; }
td, th { text-align: left; padding: 2px 12px 2px 0; vertical-align: top; }
td:nth-child(-n+2) { text-align: right; font-variant-numeric: tabular-nums; }
tr.warn { background: #fff3c4; }
tr.error { background: #ffd6d6; }
pre { background: #f4f4f4; padding: 8px; overflow-x: auto; }
img { border: 1px solid #ccc; max-width: 100%; }
</style>
<p><a href="../">all pages</a></p>
<h1>${name}</h1>
<p>Debug view: [ ${variants.map((v, i) => (i ? html` | ${v}` : v))} ] · <a href="${link("", current)}">png</a> · <a href="${link(".html")}">html</a></p>
<p>${error ? html`<b>Failed (${error.status ?? 500}):</b> ${error.message}` : html`<b>OK</b>`} · ${ms(total)} ms · ${warnings.length} warning(s)</p>
<h2>Log</h2>
<table><thead><tr><th>ms</th><th>step</th><th>message</th></tr></thead><tbody>${rows}</tbody></table>
${error?.stack ? html`<h2>Stack</h2><pre>${error.stack}</pre>` : ""}
${result ? html`<h2>Steps</h2><p>${Object.entries(result.timings).map(([k, v]) => `${k} ${v} ms`).join(" · ")}</p>
<h2>Entities read (${result.ids.length})</h2><p>${result.ids.join(", ") || "none"}</p>
<h2>Image</h2><img src="data:image/png;base64,${Buffer.from(result.png).toString("base64")}" alt="${name}">` : ""}
`);
}
