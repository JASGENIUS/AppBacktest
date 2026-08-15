/**
 * Meridian Support — the HARD example app.
 *
 * Deliberately built to stress AppBacktest far past the other examples:
 *   · authentication gate (session cookie) — evidence checks must share the
 *     browser's session, a Node-side fetch would just get a 401
 *   · 40 tickets behind search + pagination — the target is NOT on screen at
 *     the start, so the agent has to actually look for it
 *   · a three-step wizard inside a modal, with validation on step 2
 *   · a shadow-DOM priority badge and an iframe notes panel
 *   · an artificial latency + loading state on the escalate call
 *
 * FOUR planted bugs, each a different class (FIXED=1 repairs all of them):
 *   A  optimistic-UI lie   escalating a `low` priority ticket shows "Escalated"
 *                          immediately, but the server rejects it with 500 —
 *                          the UI never reconciles. (critical / discrepancy)
 *   B  data loss           failing validation on wizard step 2 wipes the
 *                          reason typed on step 1.
 *   C  permission leak     GET /api/tickets/:id has no ownership check, so any
 *                          signed-in user can read another team's ticket.
 *   D  pagination off-by-one  page 2 repeats the last row of page 1.
 */

const express = require("express");
const path = require("node:path");
const crypto = require("node:crypto");

const FIXED = process.env.FIXED === "1";
const PORT = Number(process.env.PORT || 4175);
const PAGE_SIZE = 10;
const ESCALATE_LATENCY_MS = 600;

const SUBJECTS = [
  "Cannot reset password", "Invoice missing line items", "Export stuck at 90%",
  "SSO login loop", "Webhook retries flooding", "Duplicate charge on renewal",
  "API key rotation failed", "Report shows stale totals", "Mobile app crash on upload",
  "Timezone wrong on schedule", "Bulk import skips rows", "Email digest not sending",
];
const CUSTOMERS = ["Northwind", "Acme", "Globex", "Initech", "Umbrella", "Soylent"];
const PRIORITIES = ["low", "normal", "high"];

function pristineState() {
  const tickets = [];
  for (let i = 1; i <= 40; i++) {
    tickets.push({
      id: 1000 + i,
      subject: `${SUBJECTS[i % SUBJECTS.length]} (#${1000 + i})`,
      customer: CUSTOMERS[i % CUSTOMERS.length],
      priority: PRIORITIES[i % PRIORITIES.length],
      status: "open",
      // Half belong to another team — the permission-leak surface.
      team: i % 2 === 0 ? "alpha" : "beta",
      escalations: [],
      notes: `Reported by ${CUSTOMERS[i % CUSTOMERS.length]} support.`,
    });
  }
  // A deterministic target the scenario will hunt for: low priority, page 3+.
  const target = tickets.find((t) => t.id === 1027);
  target.subject = "Payments dashboard blank after login (#1027)";
  target.priority = "low";
  target.team = "alpha";
  return { tickets, sessions: new Map() };
}

function createApp({ fixed = FIXED } = {}) {
  const app = express();
  let state = pristineState();

  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    const raw = req.headers.cookie ?? "";
    const match = /msid=([^;]+)/.exec(raw);
    req.session = match ? state.sessions.get(match[1]) : undefined;
    next();
  });

  // --- public ---
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/config.js", (_req, res) =>
    res.type("application/javascript").send(`window.__FIXED = ${fixed};`),
  );
  app.use(express.static(path.join(__dirname, "public")));

  app.post("/api/login", (req, res) => {
    const { email = "", password = "" } = req.body || {};
    if (!email.includes("@") || password.length < 4) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    const sid = crypto.randomBytes(8).toString("hex");
    state.sessions.set(sid, { email, team: "alpha" });
    res.setHeader("set-cookie", `msid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    res.json({ ok: true, email });
  });

  app.get("/api/me", (req, res) => {
    if (!req.session) return res.status(401).json({ error: "not signed in" });
    res.json(req.session);
  });

  const requireAuth = (req, res, next) =>
    req.session ? next() : res.status(401).json({ error: "not signed in" });

  // --- tickets ---
  app.get("/api/tickets", requireAuth, (req, res) => {
    const q = String(req.query.q ?? "").toLowerCase();
    const page = Math.max(1, Number(req.query.page ?? 1));
    const mine = state.tickets.filter((t) => t.team === req.session.team);
    const matched = q
      ? mine.filter((t) => t.subject.toLowerCase().includes(q) || String(t.id).includes(q))
      : mine;
    // BUG D: the offset is one short, so page 2 repeats page 1's last row.
    const offset = fixed ? (page - 1) * PAGE_SIZE : Math.max(0, (page - 1) * PAGE_SIZE - (page > 1 ? 1 : 0));
    res.json({
      page,
      pages: Math.max(1, Math.ceil(matched.length / PAGE_SIZE)),
      total: matched.length,
      tickets: matched.slice(offset, offset + PAGE_SIZE),
    });
  });

  app.get("/api/tickets/:id", requireAuth, (req, res) => {
    const ticket = state.tickets.find((t) => t.id === Number(req.params.id));
    if (!ticket) return res.status(404).json({ error: "not found" });
    // BUG C: no ownership check — any signed-in user can read any team's ticket.
    if (fixed && ticket.team !== req.session.team) {
      return res.status(403).json({ error: "forbidden" });
    }
    res.json(ticket);
  });

  app.post("/api/tickets/:id/escalate", requireAuth, (req, res) => {
    const ticket = state.tickets.find((t) => t.id === Number(req.params.id));
    if (!ticket) return res.status(404).json({ error: "not found" });
    const { reason = "", severity = "", contact = "" } = req.body || {};

    setTimeout(() => {
      if (!reason.trim() || !severity || !contact.trim()) {
        return res.status(400).json({ error: "reason, severity and contact are required" });
      }
      // BUG A: low-priority tickets are rejected by the server, but the client
      // has already told the user it worked.
      if (!fixed && ticket.priority === "low") {
        return res.status(500).json({ error: "escalation pipeline unavailable" });
      }
      ticket.escalations.push({ reason, severity, contact, at: new Date().toISOString() });
      ticket.status = "escalated";
      res.status(201).json({ ok: true, escalations: ticket.escalations.length });
    }, ESCALATE_LATENCY_MS);
  });

  app.post("/api/reset", (_req, res) => {
    state = pristineState();
    res.json({ ok: true });
  });
  app.get("/api/state", (_req, res) =>
    res.json({ tickets: state.tickets.map(({ id, status, escalations, team, priority }) => ({ id, status, escalations: escalations.length, team, priority })) }),
  );

  // --- pages ---
  app.get("/tickets/:id", (_req, res) => res.sendFile(path.join(__dirname, "public", "ticket.html")));
  app.get("/tickets", (_req, res) => res.sendFile(path.join(__dirname, "public", "tickets.html")));
  app.get("/notes-frame", (req, res) => {
    const ticket = state.tickets.find((t) => t.id === Number(req.query.id));
    res
      .type("html")
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><style>body{font:13px "Segoe UI",system-ui;margin:0;padding:10px;color:#333}</style></head>` +
          `<body><strong>Customer notes</strong><p>${ticket ? ticket.notes : "No notes."}</p></body></html>`,
      );
  });

  return app;
}

if (require.main === module) {
  createApp().listen(PORT, () => {
    console.log(`Meridian Support on http://localhost:${PORT}  (FIXED=${FIXED ? "1" : "0"})`);
  });
}

module.exports = { createApp };
