import { test } from "node:test";
import assert from "node:assert/strict";
import { createVisitorKey, randomSalt } from "./visitor.js";

const SALT = "s".repeat(32);
const key = createVisitorKey(SALT);

test("the key is a 32-character hex HMAC that never contains the IP", () => {
  const k = key("203.0.113.7");
  assert.match(k, /^[0-9a-f]{32}$/);
  assert.ok(!k.includes("203"));
  assert.equal(key("203.0.113.7"), k, "stable for the same IP");
  assert.notEqual(key("203.0.113.8"), k, "another IPv4 address is another visitor");
});

test("the salt matters: the same IP under another salt is a different key", () => {
  assert.notEqual(createVisitorKey("t".repeat(32))("203.0.113.7"), key("203.0.113.7"));
  assert.notEqual(randomSalt(), randomSalt());
  assert.match(randomSalt(), /^[0-9a-f]{64}$/);
});

test("IPv6: one /64 is one visitor, another /64 is another", () => {
  const a = key("2001:db8:1234:5678:1111:2222:3333:4444");
  assert.equal(key("2001:db8:1234:5678:ffff:ffff:ffff:ffff"), a, "same /64, different interface id");
  assert.equal(key("2001:db8:1234:5678::1"), a, "short form of the same /64");
  assert.notEqual(key("2001:db8:1234:5679::1"), a, "the next /64");
});

test("an IPv4-mapped IPv6 address is the same visitor as plain IPv4 (not one shared /64)", () => {
  assert.equal(key("::ffff:203.0.113.7"), key("203.0.113.7"));
  assert.notEqual(key("::ffff:203.0.113.7"), key("::ffff:198.51.100.1"));
});

test("no IP at all gets one shared 'unknown' key", () => {
  assert.equal(key(undefined), key(undefined));
  assert.match(key(undefined), /^[0-9a-f]{32}$/);
});
