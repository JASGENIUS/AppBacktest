/* Ticket list: search + pagination. The target ticket is deliberately not on
   page 1, so the agent has to search or page to reach it. */

let page = 1;
let q = "";

const rows = document.getElementById("rows");
const pageinfo = document.getElementById("pageinfo");
const count = document.getElementById("count");
const loading = document.getElementById("loading");

async function load() {
  loading.hidden = false;
  const res = await fetch(`/api/tickets?q=${encodeURIComponent(q)}&page=${page}`);
  if (res.status === 401) { location.href = "/"; return; }
  const data = await res.json();
  loading.hidden = true;
  rows.innerHTML = "";
  for (const t of data.tickets) {
    const tr = document.createElement("tr");
    const link = `<a href="/tickets/${t.id}">${t.subject}</a>`;
    tr.innerHTML = `<td>${link}</td><td>${t.customer}</td><td>${t.priority}</td><td>${t.status}</td>`;
    rows.appendChild(tr);
  }
  pageinfo.textContent = `Page ${data.page} of ${data.pages}`;
  count.textContent = `${data.total} tickets`;
  document.getElementById("prev").disabled = data.page <= 1;
  document.getElementById("next").disabled = data.page >= data.pages;
}

document.getElementById("search-btn").addEventListener("click", () => {
  q = document.getElementById("search").value.trim();
  page = 1;
  load();
});
document.getElementById("search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("search-btn").click();
});
document.getElementById("prev").addEventListener("click", () => { if (page > 1) { page--; load(); } });
document.getElementById("next").addEventListener("click", () => { page++; load(); });

fetch("/api/me").then((r) => (r.ok ? r.json() : null)).then((me) => {
  if (!me) { location.href = "/"; return; }
  document.getElementById("who").textContent = me.email;
  load();
});
