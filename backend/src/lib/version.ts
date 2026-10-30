import { readFileSync } from "node:fs";

// The API version comes from package.json. The path works from both src/lib (dev) and dist/lib (built).
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

export const VERSION = pkg.version;
