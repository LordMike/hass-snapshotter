import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("INDEX_PAGE disables the index only for false or 0", () => {
  assert.equal(loadConfig({}).indexPage, true);
  assert.equal(loadConfig({ INDEX_PAGE: "true" }).indexPage, true);
  assert.equal(loadConfig({ INDEX_PAGE: "no" }).indexPage, true);
  assert.equal(loadConfig({ INDEX_PAGE: "false" }).indexPage, false);
  assert.equal(loadConfig({ INDEX_PAGE: "FALSE" }).indexPage, false);
  assert.equal(loadConfig({ INDEX_PAGE: "0" }).indexPage, false);
});

const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

test("auth: none, basic, header-only", () => {
  const none = loadConfig({});
  assert.equal(none.authHeader, null);
  assert.equal(none.authError, null);
  const b = loadConfig({ AUTH_USERNAME: "bob", AUTH_PASSWORD: "pä:ss" });
  assert.equal(b.authHeader, basic("bob", "pä:ss"));
  assert.equal(b.authBasic, true);
  const h = loadConfig({ AUTH_HEADER: " Bearer abc " });
  assert.equal(h.authHeader, "Bearer abc");
  assert.equal(h.authBasic, false);
});

test("auth: invalid combinations set authError and no header", () => {
  for (const env of [
    { AUTH_USERNAME: "bob" },
    { AUTH_PASSWORD: "x" },
    { AUTH_USERNAME: "bob", AUTH_PASSWORD: "x", AUTH_HEADER: "Bearer a" },
    { AUTH_USERNAME: "bob", AUTH_HEADER: "Bearer a" },
  ]) {
    const c = loadConfig(env);
    assert.match(c.authError, /misconfigured/);
    assert.equal(c.authHeader, null);
  }
});
