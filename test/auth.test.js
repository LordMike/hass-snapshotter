import test from "node:test";
import assert from "node:assert/strict";
import { checkAuth } from "../src/auth.js";

test("checkAuth: no auth configured lets everything through", () => {
  assert.equal(checkAuth(null, undefined), true);
});

test("checkAuth: match, mismatch, missing", () => {
  assert.equal(checkAuth("Bearer abc", "Bearer abc"), true);
  assert.equal(checkAuth("Bearer abc", "Bearer abd"), false);
  assert.equal(checkAuth("Bearer abc", "Bearer abcd"), false);
  assert.equal(checkAuth("Bearer abc", undefined), false);
});
