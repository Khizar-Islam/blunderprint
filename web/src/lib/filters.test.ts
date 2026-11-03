import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { apiQuery, filtersToQuery, parseFilters, rangeStart } from "./filters";

const params = (q: string) => new URLSearchParams(q);

describe("parseFilters", () => {
  test("reads every filter", () => {
    assert.deepEqual(parseFilters(params("color=black&speed=blitz&range=90d")), { color: "black", speed: "blitz", range: "90d" });
  });
  test("drops unknown and invalid values instead of failing", () => {
    assert.deepEqual(parseFilters(params("color=purple&speed=hyper&range=7d&foo=1")), {});
    assert.deepEqual(parseFilters(params("color=White")), {}, "values are case-sensitive, like the API");
    assert.deepEqual(parseFilters(params("")), {});
  });
});

describe("filtersToQuery", () => {
  test("round-trips through parseFilters", () => {
    for (const f of [{}, { color: "white" as const }, { speed: "rapid" as const, range: "1y" as const }]) {
      assert.deepEqual(parseFilters(params(filtersToQuery(f))), f);
    }
  });
  test("always the same key order, so the same filters give the same URL", () => {
    assert.equal(filtersToQuery({ range: "30d", speed: "bullet", color: "white" }), "color=white&speed=bullet&range=30d");
    assert.equal(filtersToQuery({}), "");
  });
});

describe("rangeStart and apiQuery", () => {
  const now = new Date("2026-11-03T18:45:12Z");
  test("a range starts at 00:00 UTC that many days back, the same all day", () => {
    assert.equal(rangeStart("30d", now).toISOString(), "2026-10-04T00:00:00.000Z");
    assert.equal(rangeStart("30d", new Date("2026-11-03T00:00:01Z")).toISOString(), "2026-10-04T00:00:00.000Z");
    assert.equal(rangeStart("1y", now).toISOString(), "2025-11-03T00:00:00.000Z");
  });
  test("the API gets color, speed and a from date, never the preset", () => {
    assert.equal(apiQuery({ color: "black", speed: "blitz", range: "90d" }, now), "color=black&speed=blitz&from=2026-08-05");
    assert.equal(apiQuery({}, now), "");
  });
});
