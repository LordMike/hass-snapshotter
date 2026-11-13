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

test("states records reads, and reads of entities not fetched yet", () => {
  const missing = new Set();
  const read = new Set();
  const fetched = Object.assign(Object.create(null), { "sensor.a": { state: "1" }, "sensor.gone": null });
  const states = recordingStates(fetched, missing, read);
  assert.equal(states["sensor.a"].state, "1");
  assert.equal(states["sensor.gone"], undefined);
  assert.equal(states["sensor.b"], undefined);
  assert.equal("sensor.c" in states, false);
  assert.equal(Symbol.iterator in states, false);
  assert.equal(states.constructor, undefined);
  assert.deepEqual([...missing], ["sensor.b", "sensor.c", "constructor"]);
  assert.deepEqual([...read], ["sensor.a", "sensor.gone", "sensor.b", "sensor.c", "constructor"]);
});
