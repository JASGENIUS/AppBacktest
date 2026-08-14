import { createRequire } from "node:module";
import type { Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp } = require("../examples/pod-app/server.js") as {
  createApp: (opts?: { fixed?: boolean }) => import("express").Express;
};

const servers: Server[] = [];
function listen(app: import("express").Express): Promise<string> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      servers.push(srv);
      const addr = srv.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}
afterAll(() => {
  for (const srv of servers) srv.close();
});

const podBody = JSON.stringify({ filename: "upload.png", notes: "dock 4", bytes: 1000 });
const post = (base: string) =>
  fetch(`${base}/api/loads/38419/pods`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: podBody,
  });

describe("pod-app (planted bug)", () => {
  it("double POST creates two records — the bug is real", async () => {
    const base = await listen(createApp({ fixed: false }));
    const [a, b] = await Promise.all([post(base), post(base)]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const pods = (await (await fetch(`${base}/api/loads/38419/pods`)).json()) as unknown[];
    expect(pods).toHaveLength(2);
  });

  it("FIXED build dedupes: second identical upload within 5s is 409", async () => {
    const base = await listen(createApp({ fixed: true }));
    const [a, b] = await Promise.all([post(base), post(base)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const pods = (await (await fetch(`${base}/api/loads/38419/pods`)).json()) as unknown[];
    expect(pods).toHaveLength(1);
  });

  it("reset restores pristine state", async () => {
    const base = await listen(createApp({ fixed: false }));
    await post(base);
    await fetch(`${base}/api/reset`, { method: "POST" });
    const pods = (await (await fetch(`${base}/api/loads/38419/pods`)).json()) as unknown[];
    expect(pods).toHaveLength(0);
  });

  it("serves the detail page under /loads/:id (checks assert this URL shape)", async () => {
    const base = await listen(createApp({ fixed: false }));
    const res = await fetch(`${base}/loads/38419`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Upload POD");
    expect(html).toContain('id="pod-file"'); // hidden input — real-app shaped
  });

  it("FIXED flag reaches the client via /config.js", async () => {
    const fixedBase = await listen(createApp({ fixed: true }));
    expect(await (await fetch(`${fixedBase}/config.js`)).text()).toContain("window.__FIXED = true");
    const buggyBase = await listen(createApp({ fixed: false }));
    expect(await (await fetch(`${buggyBase}/config.js`)).text()).toContain("window.__FIXED = false");
  });
});
