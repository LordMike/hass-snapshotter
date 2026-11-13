import test from "node:test";
import assert from "node:assert/strict";
import { resolveRenderPath, PathError } from "../src/paths.js";

const config = { haOrigin: "https://ha.example.test", allowedPaths: [] };

function rejects(raw, cfg = config) {
  assert.throws(() => resolveRenderPath(raw, cfg), PathError, `expected rejection: ${raw}`);
}

test("renders a plain dashboard path on the HA origin", () => {
  assert.deepEqual(resolveRenderPath("vue-tests/0", config), {
    path: "vue-tests/0",
    url: "https://ha.example.test/vue-tests/0",
  });
});

test("cannot be pointed at another site", () => {
  for (const raw of [
    "//google.com",
    "%2F%2Fgoogle.com",
    "https://google.com",
    "https:%2F%2Fgoogle.com",
    "google.com:443/x",
    "user@google.com",
    "%5C%5Cgoogle.com",
    "..%2F..%2Fx",
    "a/../b",
    "a/./b",
    "a//b",
    "a%3Fnext=https://google.com",
    "a%23frag",
    "a b",
    "%00",
    "",
  ]) {
    rejects(raw);
  }
});

test("blocks non-dashboard HA paths", () => {
  rejects("api/states");
  rejects("auth/authorize");
  rejects("local/hass-vue/pages/all.js");
});

test("enforces allowed_paths prefixes on whole segments", () => {
  const cfg = { ...config, allowedPaths: ["vue-tests"] };
  assert.equal(resolveRenderPath("vue-tests/1", cfg).path, "vue-tests/1");
  assert.equal(resolveRenderPath("vue-tests", cfg).path, "vue-tests");
  rejects("vue-tests-other/0", cfg);
  rejects("lovelace/0", cfg);
});
