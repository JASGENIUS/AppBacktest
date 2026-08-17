/**
 * In-page walker source, evaluated inside each frame. The agent sees ONLY
 * what this walk reports. Shared helper source keeps the walker's role/name
 * computation and the act-time identity check byte-identical, so identity
 * re-verification can never disagree with perception about what a node is.
 *
 * Walk rules (see DESIGN.md §4):
 *  - visible = has client rects AND visibility !== hidden — NOT viewport-based
 *  - pierces open shadow roots; input[type=hidden|file] never listed
 *    (file inputs are reached through their styled proxy + filechooser)
 *  - accessible-name-lite: aria-label → aria-labelledby → label[for] →
 *    ancestor label → innerText → placeholder → title → lone img alt
 *  - occlusion flagged for in-viewport elements via elementFromPoint
 *  - elements capped at 80, textDigest capped at 1500 chars (marked)
 */

const HELPERS_SOURCE = `
  const __norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const __roleOf = (el) => {
    const r = el.getAttribute && el.getAttribute("role");
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === "a") return "link";
    if (t === "button" || t === "summary") return "button";
    if (t === "select") return "select";
    if (t === "textarea") return "textbox";
    if (el.hasAttribute && el.hasAttribute("contenteditable")) return "textbox";
    if (t === "input") {
      const ty = (el.getAttribute("type") || "text").toLowerCase();
      if (ty === "checkbox") return "checkbox";
      if (ty === "radio") return "radio";
      if (ty === "file") return "file";
      if (ty === "password") return "password";
      if (ty === "button" || ty === "submit" || ty === "reset") return "button";
      return "textbox";
    }
    return "button";
  };
  const __nameOf = (el, doc) => {
    const al = el.getAttribute && el.getAttribute("aria-label");
    if (al && __norm(al)) return __norm(al);
    const lb = el.getAttribute && el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb.split(/\\s+/).map((id) => {
        const n = doc.getElementById(id);
        return n ? n.textContent : "";
      }).join(" ");
      if (__norm(t)) return __norm(t);
    }
    if (el.id) {
      try {
        const l = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l && __norm(l.textContent)) return __norm(l.textContent);
      } catch (e) {}
    }
    const anc = el.closest && el.closest("label");
    if (anc && __norm(anc.textContent)) return __norm(anc.textContent).slice(0, 80);
    const it = el.innerText !== undefined ? el.innerText : el.textContent;
    if (__norm(it)) return __norm(it).slice(0, 80);
    const ph = el.getAttribute && el.getAttribute("placeholder");
    if (ph && __norm(ph)) return __norm(ph);
    const ti = el.getAttribute && el.getAttribute("title");
    if (ti && __norm(ti)) return __norm(ti);
    const img = el.querySelector && el.querySelector("img[alt]");
    if (img) return __norm(img.getAttribute("alt"));
    return "";
  };
`;

export const WALKER_SOURCE = `((framePrefix) => {
  ${HELPERS_SOURCE}
  const CAND = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[onclick],[contenteditable="true"]';
  // Clear tags from the previous walk. Without this an element keeps a ref it
  // no longer owns, two nodes can share one ref, and a lookup silently
  // resolves to the wrong element.
  const clearTags = (root) => {
    root.querySelectorAll("[data-abt-ref]").forEach((el) => el.removeAttribute("data-abt-ref"));
    root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) clearTags(el.shadowRoot); });
  };
  clearTags(document);
  const found = [];
  const collect = (root) => {
    root.querySelectorAll(CAND).forEach((el) => found.push(el));
    root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) collect(el.shadowRoot); });
  };
  collect(document);
  const seen = new Set();
  const uniq = [];
  for (const el of found) { if (!seen.has(el)) { seen.add(el); uniq.push(el); } }

  const visible = (el) => {
    // Never perceive AppBacktest's own watch-mode overlay.
    if (el.closest && el.closest("[data-abt-ui]")) return false;
    if (el.tagName === "INPUT") {
      const ty = (el.getAttribute("type") || "text").toLowerCase();
      if (ty === "hidden" || ty === "file") return false;
    }
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    try { if (getComputedStyle(el).visibility === "hidden") return false; } catch (e) {}
    return true;
  };
  const vis = uniq.filter(visible);

  const infos = vis.map((el) => ({ el, role: __roleOf(el), name: __nameOf(el, el.ownerDocument || document) }));
  const counts = {};
  for (const i of infos) {
    const key = i.role + "|" + i.name;
    i.nth = counts[key] || 0;
    counts[key] = i.nth + 1;
  }

  const vw = window.innerWidth, vh = window.innerHeight;
  const out = [];
  const cap = Math.min(infos.length, 80);
  for (let idx = 0; idx < cap; idx++) {
    const i = infos[idx];
    const el = i.el;
    el.setAttribute("data-abt-ref", framePrefix + ":e" + idx);
    let occluded = false;
    try {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (r.width > 0 && r.height > 0 && cx >= 0 && cy >= 0 && cx < vw && cy < vh) {
        const root = el.getRootNode();
        const hit = (root.elementFromPoint ? root : document).elementFromPoint(cx, cy);
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) occluded = true;
      }
    } catch (e) {}
    const item = {
      ref: framePrefix + ":e" + idx,
      role: i.role,
      name: i.name,
      nth: i.nth,
    };
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") item.disabled = true;
    // Toggle state. Without this a selected option looks identical to an
    // unselected one, and an agent has no way to know its click registered —
    // it just clicks again, and again.
    const pressed = el.getAttribute("aria-pressed");
    const selected = el.getAttribute("aria-selected");
    const checkedAttr = el.getAttribute("aria-checked");
    if (pressed === "true" || selected === "true" || checkedAttr === "true") item.selected = true;
    else if (pressed === "false" || selected === "false" || checkedAttr === "false") item.selected = false;
    else if (el.checked === true) item.selected = true;
    else if (el.checked === false && (i.role === "checkbox" || i.role === "radio")) item.selected = false;
    if (occluded) item.occluded = true;
    // Never read the VALUE of a password field back out of the page.
    if (i.role === "password") item.sensitive = true;
    if (i.role === "textbox" || i.role === "select") {
      const v = el.value !== undefined ? String(el.value) : "";
      if (v) item.value = v.slice(0, 100);
    }
    if (el.tagName === "SELECT") {
      item.options = Array.from(el.options).slice(0, 20).map((o) => ({ value: o.value, label: __norm(o.label || o.text) }));
    }
    out.push(item);
  }

  let modalOpen;
  // A dialog that is hidden is not open — [hidden], display:none and
  // zero-size all count as closed, or every app with a pre-rendered modal
  // would look permanently blocked.
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], dialog[open]'));
  const dlg = dialogs.find((d) => {
    if (d.hasAttribute("hidden")) return false;
    if (!d.getClientRects || d.getClientRects().length === 0) return false;
    try {
      const cs = getComputedStyle(d);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    } catch (e) {}
    return true;
  });
  if (dlg) {
    const h = dlg.querySelector("h1,h2,h3,h4");
    modalOpen = __norm(dlg.getAttribute("aria-label") || (h && h.textContent) || dlg.textContent).slice(0, 80) || "dialog";
  }

  const mainEl = document.querySelector('main,[role="main"]');
  let digest = __norm((mainEl || document.body || {}).innerText || "");
  if (digest.length > 1500) digest = digest.slice(0, 1500) + " ...[truncated]";

  return { url: location.href, title: document.title, textDigest: digest, modalOpen, elements: out };
})`;

/** Act-time identity check: what is the tagged node NOW? null when gone. */
export const IDENTITY_SOURCE = `((sel) => {
  ${HELPERS_SOURCE}
  const find = (root) => {
    const el = root.querySelector(sel);
    if (el) return el;
    for (const host of root.querySelectorAll("*")) {
      if (host.shadowRoot) {
        const hit = find(host.shadowRoot);
        if (hit) return hit;
      }
    }
    return null;
  };
  const el = find(document);
  if (!el) return null;
  return { role: __roleOf(el), name: __nameOf(el, el.ownerDocument || document) };
})`;

/**
 * Find the file input associated with a clicked "choose" proxy and tag it
 * data-abt-upload. Returns true when one was found.
 */
export const FILE_INPUT_SOURCE = `((sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const mark = (input) => { input.setAttribute("data-abt-upload", "1"); return true; };
  document.querySelectorAll("[data-abt-upload]").forEach((n) => n.removeAttribute("data-abt-upload"));
  if (el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "file") return mark(el);
  if (el.tagName === "LABEL" && el.htmlFor) {
    const t = document.getElementById(el.htmlFor);
    if (t && t.type === "file") return mark(t);
  }
  const lab = el.closest("label");
  if (lab) {
    const inp = lab.querySelector('input[type="file"]');
    if (inp) return mark(inp);
  }
  const within = el.querySelector && el.querySelector('input[type="file"]');
  if (within) return mark(within);
  const form = el.closest("form");
  if (form) {
    const inp = form.querySelector('input[type="file"]');
    if (inp) return mark(inp);
  }
  return false;
})`;

/**
 * The drawn cursor, injected on every document.
 *
 * This runs in EVERY run, not just watch mode, because the cursor is what
 * makes a replay legible — without it a screenshot cannot show which control
 * the probe actually hit. Watch mode adds the HUD and the glide
 * animation on top (signalled by window.__abt_hud_goal being defined).
 *
 * Everything here is marked data-abt-ui (excluded from perception) and
 * pointer-events:none, so it can neither be perceived nor occlude a real
 * element — the overlay must never change what the run does.
 */
export const WATCH_OVERLAY_SOURCE = `(() => {
  const install = () => {
    if (!document.body || document.getElementById("__abt_cursor")) return;
    const watch = typeof window.__abt_hud_goal === "string";
    const mk = (id, css) => {
      const el = document.createElement("div");
      el.id = id;
      el.setAttribute("data-abt-ui", "");
      el.style.cssText = "pointer-events:none;" + css;
      return el;
    };
    const cursor = mk("__abt_cursor",
      "position:fixed;left:-80px;top:-80px;width:20px;height:20px;border-radius:50%;" +
      "background:rgba(255,72,72,.30);border:2px solid #ff4848;z-index:2147483647;" +
      "box-shadow:0 0 0 4px rgba(255,72,72,.14);" +
      // Headless runs place the cursor instantly: a transition would race the
      // screenshot and catch the dot mid-flight, somewhere it never clicked.
      (watch ? "transition:left .42s cubic-bezier(.4,0,.2,1),top .42s cubic-bezier(.4,0,.2,1)" : ""));
    const ring = mk("__abt_ring",
      "position:fixed;left:-80px;top:-80px;width:20px;height:20px;border-radius:50%;" +
      "border:2px solid #ff4848;opacity:0;z-index:2147483647");
    const style = document.createElement("style");
    style.setAttribute("data-abt-ui", "");
    style.textContent =
      "@keyframes __abt_pulse{0%{transform:scale(1);opacity:.9}100%{transform:scale(3.4);opacity:0}}";
    if (document.head) document.head.appendChild(style);
    document.body.appendChild(cursor);
    document.body.appendChild(ring);

    if (!watch) return;
    const hud = mk("__abt_hud",
      "position:fixed;left:0;right:0;bottom:0;z-index:2147483646;background:rgba(16,18,22,.94);" +
      "color:#fff;font:13px/1.5 'Segoe UI',system-ui,sans-serif;padding:9px 16px;" +
      "border-top:2px solid #ff4848");
    const clamp = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    hud.innerHTML =
      '<div style="opacity:.55;font-size:10px;letter-spacing:.10em;text-transform:uppercase">' +
      'AppBacktest &middot; simulated user <span id="__abt_step"></span></div>' +
      '<div id="__abt_goal" style="opacity:.7;margin-top:1px;font-size:12px;' + clamp + '"></div>' +
      '<div id="__abt_act" style="margin-top:3px;font-weight:600;' + clamp + '">starting up&hellip;</div>';
    document.body.appendChild(hud);
    const g = document.getElementById("__abt_goal");
    if (g) g.textContent = window.__abt_hud_goal;
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
  // Re-install if the app replaces the body (SPA route swaps). documentElement
  // can still be null this early (init scripts run before parsing on
  // about:blank and on brand-new documents), and observing null throws a
  // page error that would surface as a finding against the app under test.
  const watchBody = () => {
    if (!document.documentElement) return false;
    new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: false });
    return true;
  };
  if (!watchBody()) document.addEventListener("DOMContentLoaded", watchBody);
})()`;

/** Move the cursor to an element (or just update the HUD line). */
export const WATCH_UPDATE_SOURCE = `((selector, label, pulse, step) => {
  const cursor = document.getElementById("__abt_cursor");
  const ring = document.getElementById("__abt_ring");
  const act = document.getElementById("__abt_act");
  const stepEl = document.getElementById("__abt_step");
  if (act && label) act.textContent = label;
  if (stepEl && step) stepEl.textContent = "\\u00b7 " + step;
  if (!cursor || !selector) return;
  let el = document.querySelector(selector);
  if (!el) {
    for (const host of document.querySelectorAll("*")) {
      if (host.shadowRoot) {
        const hit = host.shadowRoot.querySelector(selector);
        if (hit) { el = hit; break; }
      }
    }
  }
  if (!el) return;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  cursor.style.left = (x - 10) + "px";
  cursor.style.top = (y - 10) + "px";
  if (pulse && ring) {
    ring.style.left = (x - 10) + "px";
    ring.style.top = (y - 10) + "px";
    ring.style.animation = "none";
    void ring.offsetWidth;
    ring.style.animation = "__abt_pulse .55s ease-out";
  }
})`;

/**
 * Transient-feedback capture (toasts / aria-live), installed as an init script.
 *
 * Messages are pushed to a Node-side binding the moment they appear, because
 * "Saved!" toasts routinely live in a document that then navigates away —
 * reading them out of the page later loses them. The in-page array remains as
 * a fallback for the window before the binding is installed.
 */
export const TRANSIENT_OBSERVER_SOURCE = `(() => {
  const LIVE = '[role="alert"],[role="status"],[aria-live]';
  window.__abt_transients = window.__abt_transients || [];
  const push = (t) => {
    const s = (t || "").replace(/\\s+/g, " ").trim();
    if (!s || window.__abt_last === s) return;
    window.__abt_last = s;
    if (typeof window.__abtPushTransient === "function") {
      try { window.__abtPushTransient(s); return; } catch (e) {}
    }
    window.__abt_transients.push(s);
  };
  const scan = (n) => {
    if (!n) return;
    if (n.nodeType === 3) {
      const p = n.parentElement;
      if (p && p.closest(LIVE)) push(p.closest(LIVE).textContent);
      return;
    }
    if (n.nodeType !== 1) return;
    if (n.matches && n.matches(LIVE)) push(n.textContent);
    else if (n.closest && n.closest(LIVE)) push(n.closest(LIVE).textContent);
    if (n.querySelectorAll) n.querySelectorAll(LIVE).forEach((x) => push(x.textContent));
  };
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "characterData") { scan(m.target); continue; }
      m.addedNodes && m.addedNodes.forEach(scan);
    }
  });
  const start = () => {
    if (document.documentElement) {
      mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})()`;
