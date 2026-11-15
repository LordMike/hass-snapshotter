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
