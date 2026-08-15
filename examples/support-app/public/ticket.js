/* Ticket detail + escalate wizard. Planted bugs A (optimistic-UI lie) and
   B (data loss on validation) live in here. */

const ticketId = Number(location.pathname.split("/").pop());

// A shadow-DOM component: the walker must pierce this to see the priority.
class PriorityBadge extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>span{font-size:12px;padding:2px 8px;border:1px solid #c9cdd4;border-radius:99px}</style><span id="v">—</span>`;
  }
  set value(v) {
    const el = this.shadowRoot && this.shadowRoot.getElementById("v");
    if (el) el.textContent = `priority: ${v}`;
  }
}
customElements.define("priority-badge", PriorityBadge);

const toast = document.getElementById("toast");
const wizard = document.getElementById("wizard");
const stepTitle = document.getElementById("step-title");
const stepError = document.getElementById("step-error");
const backBtn = document.getElementById("wizard-back");
const nextBtn = document.getElementById("wizard-next");
const submitBtn = document.getElementById("wizard-submit");

let step = 1;
let ticket = null;

function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, 5000);
}

function renderStep() {
  for (const n of [1, 2, 3]) document.getElementById(`step-${n}`).hidden = n !== step;
  stepTitle.textContent = `Step ${step} of 3 — ${["Reason", "Severity", "Contact"][step - 1]}`;
  backBtn.disabled = step === 1;
  nextBtn.hidden = step === 3;
  submitBtn.hidden = step !== 3;
  stepError.hidden = true;
}

async function load() {
  const res = await fetch(`/api/tickets/${ticketId}`);
  if (res.status === 401) { location.href = "/"; return; }
  if (!res.ok) {
    document.getElementById("subject").textContent = "Ticket unavailable";
    return;
  }
  ticket = await res.json();
  document.getElementById("subject").textContent = ticket.subject;
  document.getElementById("customer").textContent = ticket.customer;
  document.getElementById("badge").value = ticket.priority;
  document.getElementById("status-line").textContent = `Status: ${ticket.status}`;
  document.getElementById("notes").src = `/notes-frame?id=${ticketId}`;
  renderTriage();
}

document.getElementById("escalate-btn").addEventListener("click", () => {
  step = 1;
  renderStep();
  wizard.hidden = false;
  document.getElementById("reason").focus();
});

nextBtn.addEventListener("click", () => {
  if (step === 2 && !document.getElementById("severity").value) {
    stepError.textContent = "Choose a severity before continuing.";
    stepError.hidden = false;
    // BUG B: the validation path resets the form, silently wiping the reason
    // the user typed on step 1.
    if (!window.__FIXED) document.getElementById("reason").value = "";
    return;
  }
  if (step < 3) { step += 1; renderStep(); }
});

backBtn.addEventListener("click", () => { if (step > 1) { step -= 1; renderStep(); } });

submitBtn.addEventListener("click", async () => {
  const payload = {
    reason: document.getElementById("reason").value,
    severity: document.getElementById("severity").value,
    contact: document.getElementById("contact").value,
  };
  wizard.hidden = true;

  if (window.__FIXED) {
    // Correct: wait for the server, then report what actually happened.
    const res = await fetch(`/api/tickets/${ticketId}/escalate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      showToast("Ticket escalated");
      load();
    } else {
      const body = await res.json().catch(() => ({}));
      showToast(`Escalation failed: ${body.error || res.status}`);
    }
    return;
  }

  // BUG A: optimistic UI — announce success immediately and never reconcile
  // with the server's answer.
  showToast("Ticket escalated");
  document.getElementById("status-line").textContent = "Status: escalated";
  fetch(`/api/tickets/${ticketId}/escalate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
});

load();

// --- Triage (the concurrent-edit surface) ---
const triageState = document.getElementById("triage-state");

function renderTriage() {
  if (!ticket) return;
  const tags = (ticket.tags ?? []).join(", ") || "none";
  triageState.textContent = `Assigned to: ${ticket.assignee || "nobody"} · tags: ${tags}`;
}

document.getElementById("save-triage").addEventListener("click", async () => {
  const assignee = document.getElementById("assignee").value.trim();
  const tag = document.getElementById("tag").value.trim();
  const tags = tag ? [...(ticket.tags ?? []), tag] : ticket.tags ?? [];
  const res = await fetch(`/api/tickets/${ticketId}/triage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignee, tags, version: ticket.version }),
  });
  if (res.ok) {
    const body = await res.json();
    ticket = body.ticket;
    renderTriage();
    showToast("Triage saved");
    return;
  }

  if (res.status === 409) {
    // Only the FIXED build produces this. Detecting the conflict is half the
    // fix; recovering from it is the other half — reload the current state and
    // reapply this user's intent on top, so nobody's work is lost.
    const fresh = await (await fetch(`/api/tickets/${ticketId}`)).json();
    ticket = fresh;
    const merged = tag ? [...new Set([...(fresh.tags ?? []), tag])] : fresh.tags ?? [];
    const retry = await fetch(`/api/tickets/${ticketId}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignee, tags: merged, version: fresh.version }),
    });
    if (retry.ok) {
      ticket = (await retry.json()).ticket;
      renderTriage();
      showToast("Triage saved");
    } else {
      showToast("Someone else changed this ticket. Reload before saving.");
    }
    return;
  }

  showToast("Could not save triage");
});
