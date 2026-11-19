// The security headers every response of the site carries (next.config.ts `headers()`).
//
// Four are enforced: no MIME sniffing, a short referrer, no framing, and no camera, microphone
// or location. The Content-Security-Policy (CSP: a list, per kind of resource, of where the page
// may load it from) is sent as Content-Security-Policy-REPORT-ONLY for now: the browser reports
// a violation in its console but blocks nothing. It becomes enforcing once the live site has run
// with no violations (scripts/ui-csp.mjs).
//
// What the policy does and does not do:
// - connect-src pins where the page can send data: itself and the API (fetch, the SSE streams,
//   sendBeacon). frame-ancestors stops other sites framing it; object-src, base-uri and
//   form-action close plugins, <base> and form targets.
// - script-src keeps 'unsafe-inline': Next.js puts small inline scripts in every page, and the
//   alternative (a nonce per request) would make every page server-rendered on each visit. So
//   this policy does NOT stop an injected inline script; it limits where scripts are loaded FROM
//   and where the page can connect. The app renders no HTML from users or the API.
// - 'wasm-unsafe-eval' lets the Stockfish worker compile its WebAssembly; worker-src 'self' is
//   the worker itself. The same headers go out on /engine/*, because a worker is governed by the
//   policy that arrives with its own script.
// - style-src keeps 'unsafe-inline': React and motion write inline style attributes.
// - Fonts are self-hosted by next/font, so font-src is 'self'.

export interface Header {
  key: string;
  value: string;
}

// The API origin ("https://host[:port]") from NEXT_PUBLIC_API_URL, or null when it is unset or
// unreadable (then the page can only connect to itself).
export function apiOrigin(apiUrl: string | undefined): string | null {
  if (!apiUrl) return null;
  try {
    const url = new URL(apiUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function contentSecurityPolicy(apiUrl: string | undefined, dev: boolean): string {
  const api = apiOrigin(apiUrl);
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    // Development only: React needs eval for its error overlays.
    ["script-src", ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", ...(dev ? ["'unsafe-eval'"] : [])]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'", ...(api ? [api] : [])]],
    ["worker-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ");
}

export function securityHeaders(apiUrl: string | undefined, dev: boolean): Header[] {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy(apiUrl, dev) },
  ];
}
