import { test } from "node:test";
import assert from "node:assert/strict";
import { shortCommit } from "./version.js";

test("shortCommit: Render's full SHA → its first 7 characters, lower case", () => {
  assert.equal(shortCommit("84AB56E360577BC921E33C0666F6108EFADBEA42"), "84ab56e");
  assert.equal(shortCommit("  3fd43848ee3a3f72e8537399e382ca51c2d13124\n"), "3fd4384");
  assert.equal(shortCommit("877db29"), "877db29");
});

test("shortCommit: unset, empty or not a hex SHA → dev (locally, in tests)", () => {
  for (const v of [undefined, "", "   ", "abc12", "main", "84ab56e-dirty", "<script>"]) assert.equal(shortCommit(v), "dev");
});
