// NEXT_PUBLIC_ variables are inlined into the browser bundle at build time.
// Strip a trailing slash so `${API_URL}/api/...` never has a double slash.
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

export interface Health {
  ok: boolean;
  db: boolean;
  queueDepth: number;
  version: string;
}

export async function fetchHealth(signal: AbortSignal): Promise<Health> {
  const res = await fetch(`${API_URL}/api/health`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`Health check returned ${res.status}`);
  return (await res.json()) as Health;
}
