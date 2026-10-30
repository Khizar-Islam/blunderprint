import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Don't (re)write AGENTS.md on every `next dev`; CLAUDE.md is the single source of truth.
  agentRules: false,
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
