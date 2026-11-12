import { readFileSync } from "node:fs";

// The API version comes from package.json. The path works from both src/lib (dev) and dist/lib (built).
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

export const VERSION = pkg.version;

// Which deploy is running: Render sets RENDER_GIT_COMMIT ("The commit SHA for a service or
// deploy", available at build time and runtime: render.com/docs/environment-variables). The first
// 7 characters, like git's short hash; "dev" when unset or not a hex SHA (locally, in tests).
export function shortCommit(sha: string | undefined): string {
  const s = sha?.trim() ?? "";
  return /^[0-9a-f]{7,64}$/i.test(s) ? s.slice(0, 7).toLowerCase() : "dev";
}

export const COMMIT = shortCommit(process.env.RENDER_GIT_COMMIT);
