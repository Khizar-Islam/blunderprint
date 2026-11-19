import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FIRST_ROWS, urgentRowCount } from "./firstRows";

describe("urgentRowCount", () => {
  test("a list that has just arrived shows its first rows, the rest follow", () => {
    assert.equal(urgentRowCount(200, 0, false), FIRST_ROWS);
  });
  test("a short list is shown whole", () => {
    assert.equal(urgentRowCount(12, 0, false), 12);
    assert.equal(urgentRowCount(0, 0, false), 0);
  });
  test("once the full list has been drawn, all of it is shown", () => {
    assert.equal(urgentRowCount(200, 200, true), 200);
  });
  test("a refreshed list never takes away rows that were already drawn", () => {
    assert.equal(urgentRowCount(200, 200, false), 200);
    assert.equal(urgentRowCount(203, 200, false), 200);
  });
  test("a list that grows while games stream in keeps what it had", () => {
    assert.equal(urgentRowCount(100, 50, false), 50);
    assert.equal(urgentRowCount(40, 10, false), FIRST_ROWS);
  });
  test("a list that got shorter shows no more than it has", () => {
    assert.equal(urgentRowCount(150, 200, false), 150);
  });
});
