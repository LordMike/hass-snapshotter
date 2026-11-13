import test from "node:test";
import assert from "node:assert/strict";
import { html, raw } from "../src/html.js";
import { recordingStates } from "../src/hass.js";

test("escapes interpolated entity values", () => {
  const state = `<img src=x onerror="a">&'`;
  assert.equal(String(html`<b>${state}</b>`), "<b>&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;</b>");
});

test("nests html, joins arrays, passes raw, drops nullish/false", () => {
  const items = ["a", "<b>"].map((x) => html`<li>${x}</li>`);
  assert.equal(String(html`<ul>${items}</ul>${raw("<hr>")}${null}${undefined}${false}${0}`), "<ul><li>a</li><li>&lt;b&gt;</li></ul><hr>0");
});

test("states records reads of entities not fetched yet", () => {
  const missing = new Set();
  const states = recordingStates({ "sensor.a": { state: "1" }, "sensor.gone": null }, missing);
  assert.equal(states["sensor.a"].state, "1");
  assert.equal(states["sensor.gone"], undefined);
  assert.equal(states["sensor.b"], undefined);
  assert.equal("sensor.c" in states, false);
  assert.deepEqual([...missing], ["sensor.b", "sensor.c"]);
});
