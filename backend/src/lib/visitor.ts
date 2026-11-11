import { createHmac, randomBytes } from "node:crypto";
import type { RequestHandler } from "express";
import { ipKeyGenerator } from "express-rate-limit";

// Who is asking, without storing who they are (CLAUDE.md §10 "Guards").
//
// The per-visitor limits need a stable key per visitor, but a raw IP address is personal data:
// it is never stored (the `usage` counters) and never logged. Instead every request gets
//
//   HMAC-SHA256(IP_HASH_SALT, ip), first 16 bytes as hex (32 characters)
//
// An HMAC is a hash with a secret key. Without the salt, nobody can turn the stored value back
// into an IP by hashing all 4 billion IPv4 addresses (a plain SHA-256 of an IP can be reversed
// that way in minutes). With the salt only on Render, a leaked `usage` collection reveals nothing.
//
// IPv6: one home or phone usually gets a whole /64 block (2^64 addresses), so keying by the full
// address would let one visitor rotate through endless "different" visitors. ipKeyGenerator
// (from express-rate-limit) reduces an IPv6 address to its /64 network first, and turns an
// IPv4-mapped IPv6 address ("::ffff:1.2.3.4") back into plain IPv4, so both spellings of one
// IPv4 visitor share a key.

export const IPV6_SUBNET = 64;

export type VisitorKey = (ip: string | undefined) => string;

export function createVisitorKey(salt: string): VisitorKey {
  return (ip) => {
    const network = ip ? ipKeyGenerator(ip, IPV6_SUBNET) : "unknown";
    return createHmac("sha256", salt).update(network).digest("hex").slice(0, 32);
  };
}

// A salt for local development when IP_HASH_SALT isn't set (production refuses to start without
// one, config/env.ts). Random per process: the counters of a dev visitor reset on restart.
export const randomSalt = (): string => randomBytes(32).toString("hex");

// Puts the visitor's key on res.locals.visitor for the limiters and routes after it. Must run
// after `trust proxy` is set, so req.ip is the visitor and not Render's proxy.
export function visitorMiddleware(key: VisitorKey): RequestHandler {
  return (req, res, next) => {
    res.locals.visitor = key(req.ip ?? req.socket.remoteAddress);
    next();
  };
}
