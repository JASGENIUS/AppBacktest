/**
 * PODHaul — the AppBacktest example app, with a PLANTED BUG.
 *
 * The bug (two halves, like the real-world version of this defect):
 *   client: the "Upload POD" button is not disabled while the request is in
 *           flight, so a double-click fires two POSTs;
 *   server: POST /api/loads/:id/pods does not dedupe, so both create records.
 *
 * Run with FIXED=1 to repair both halves (server dedupes identical uploads
 * within 5s; client disables the button while submitting) — then
 * `appbacktest regression` flips the promoted fixture to FIXED.
 */

const express = require("express");
const path = require("node:path");

const FIXED = process.env.FIXED === "1";
const PORT = Number(process.env.PORT || 4173);
const LATENCY_MS = 700; // the in-flight window a double-click exploits

function pristineState() {
  return {
    loads: [
      { id: 38419, origin: "Chicago, IL", destination: "Detroit, MI", status: "in_transit", pods: [] },
      { id: 27021, origin: "Toledo, OH", destination: "Columbus, OH", status: "delivered", pods: [] },
      { id: 30553, origin: "Gary, IN", destination: "Fort Wayne, IN", status: "assigned", pods: [] },
    ],
    nextPodId: 1,
  };
}

function createApp({ fixed = FIXED } = {}) {
  const app = express();
  let state = pristineState();

  app.use(express.json({ limit: "30mb" }));
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/config.js", (_req, res) => {
    res.type("application/javascript").send(`window.__FIXED = ${fixed};`);
  });

  // Pretty route for the detail page so checks can assert url contains "/loads/"
  app.get("/loads/:id", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "load.html"));
  });

  app.get("/api/loads", (_req, res) => res.json(state.loads));

  app.get("/api/loads/:id", (req, res) => {
    const load = state.loads.find((l) => l.id === Number(req.params.id));
    if (!load) return res.status(404).json({ error: "load not found" });
    res.json(load);
  });

  app.get("/api/loads/:id/pods", (req, res) => {
    const load = state.loads.find((l) => l.id === Number(req.params.id));
    if (!load) return res.status(404).json({ error: "load not found" });
    res.json(load.pods);
  });

  app.post("/api/loads/:id/pods", (req, res) => {
    const load = state.loads.find((l) => l.id === Number(req.params.id));
    if (!load) return res.status(404).json({ error: "load not found" });
    const { filename = "photo.png", notes = "", bytes = 0 } = req.body || {};

    setTimeout(() => {
      if (fixed) {
        const now = Date.now();
        const dup = load.pods.find((p) => p.filename === filename && now - p.atMs < 5000);
        if (dup) return res.status(409).json({ error: "duplicate" });
      }
      // PLANTED BUG (unfixed): no dedupe — every request creates a record.
      const pod = {
        id: state.nextPodId++,
        filename,
        notes,
        bytes,
        at: new Date().toISOString(),
        atMs: Date.now(),
      };
      load.pods.push(pod);
      res.status(201).json({ ok: true, pod: { id: pod.id, filename: pod.filename } });
    }, LATENCY_MS);
  });

  app.post("/api/reset", (_req, res) => {
    state = pristineState();
    res.json({ ok: true });
  });

  app.get("/api/state", (_req, res) => res.json(state));

  return app;
}

if (require.main === module) {
  createApp().listen(PORT, () => {
    console.log(`PODHaul demo on http://localhost:${PORT}  (FIXED=${FIXED ? "1" : "0"})`);
  });
}

module.exports = { createApp };
