import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/securityHeaders";

const nextConfig: NextConfig = {
  // Don't (re)write AGENTS.md on every `next dev`; CLAUDE.md is the single source of truth.
  agentRules: false,
  // Security headers on every path (pages, static files and the engine's worker script alike):
  // see src/lib/securityHeaders.ts. NEXT_PUBLIC_API_URL is read at build time, as the app reads it.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders(process.env.NEXT_PUBLIC_API_URL, process.env.NODE_ENV !== "production"),
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
