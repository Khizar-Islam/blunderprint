import type { AddressInfo } from "node:net";
import type { Express } from "express";

// Starts an app on a random free port for a test and returns its base URL and a close function.
export async function startTestServer(app: Express): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = await new Promise<ReturnType<Express["listen"]>>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
