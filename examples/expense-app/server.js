/**
 * Cove — a team expense tool. The SECOND example app, deliberately built to
 * exercise paths the POD demo never touches: a native <select>, a modal
 * dialog, and a confirm() delete.
 *
 * PLANTED BUG (a state-desync, not another double-submit): the note modal's
 * close handler resets the form's JS category state without touching the
 * <select> element, so the UI keeps showing "Meals" while the request sends
 * "uncategorized". The user sees the category they picked, the toast says
 * submitted, and the server records the wrong one. Classic React-style
 * DOM/state divergence.
 *
 * FIXED=1 repairs it (the modal stops clobbering unrelated form state).
 */

const express = require("express");
const path = require("node:path");

const FIXED = process.env.FIXED === "1";
const PORT = Number(process.env.PORT || 4174);

const CATEGORIES = ["uncategorized", "meals", "travel", "software", "lodging"];

function pristineState() {
  return {
    expenses: [
      { id: 1, description: "Monitor stand", amount: "89.00", category: "software", note: "", status: "approved" },
      { id: 2, description: "Taxi to airport", amount: "62.40", category: "travel", note: "", status: "submitted" },
    ],
    nextId: 3,
  };
}

function createApp({ fixed = FIXED } = {}) {
  const app = express();
  let state = pristineState();

  app.use(express.json({ limit: "2mb" }));
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/config.js", (_req, res) => {
    res.type("application/javascript").send(`window.__FIXED = ${fixed};`);
  });

  app.get("/new", (_req, res) => res.sendFile(path.join(__dirname, "public", "new.html")));

  app.get("/api/expenses", (_req, res) => res.json(state.expenses));

  app.post("/api/expenses", (req, res) => {
    const { description = "", amount = "", category = "uncategorized", note = "" } = req.body || {};
    if (!description.trim()) return res.status(400).json({ error: "description required" });
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: "unknown category" });

    setTimeout(() => {
      const expense = {
        id: state.nextId++,
        description: description.trim(),
        amount: String(amount).trim(),
        category,
        note,
        status: "submitted",
      };
      state.expenses.push(expense);
      res.status(201).json({ ok: true, expense });
    }, 350);
  });

  app.delete("/api/expenses/:id", (req, res) => {
    const id = Number(req.params.id);
    const idx = state.expenses.findIndex((e) => e.id === id);
    if (idx === -1) return res.status(404).json({ error: "not found" });
    state.expenses.splice(idx, 1);
    res.json({ ok: true });
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
    console.log(`Cove expenses on http://localhost:${PORT}  (FIXED=${FIXED ? "1" : "0"})`);
  });
}

module.exports = { createApp };
