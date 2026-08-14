/* PODHaul load-detail page. The planted client bug lives in submit(). */

const loadId = Number(location.pathname.split("/").pop());
const fileInput = document.getElementById("pod-file");
const chooseBtn = document.getElementById("choose-btn");
const chosenName = document.getElementById("chosen-name");
const notesInput = document.getElementById("notes");
const uploadBtn = document.getElementById("upload-btn");
const toast = document.getElementById("toast");
const podList = document.getElementById("pod-list");

let chosenFile = null;

async function loadDetails() {
  const res = await fetch(`/api/loads/${loadId}`);
  if (!res.ok) {
    document.getElementById("load-title").textContent = "Load not found";
    return;
  }
  const load = await res.json();
  document.getElementById("load-title").textContent = `Load #${load.id}`;
  document.getElementById("load-meta").textContent =
    `${load.origin} → ${load.destination} · ${load.status.replace("_", " ")}`;
}

async function refreshPods() {
  const res = await fetch(`/api/loads/${loadId}/pods`);
  const pods = await res.json();
  podList.innerHTML = "";
  if (pods.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "None yet";
    podList.appendChild(li);
    return;
  }
  for (const pod of pods) {
    const li = document.createElement("li");
    li.textContent = `POD #${pod.id} — ${pod.filename}`;
    podList.appendChild(li);
  }
}

function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, 4000);
}

chooseBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  chosenFile = fileInput.files[0] || null;
  chosenName.textContent = chosenFile ? chosenFile.name : "";
});

async function submit() {
  if (!chosenFile) {
    showToast("Choose a photo first");
    return;
  }
  // FIXED build disables the button while the request is in flight.
  // PLANTED BUG (unfixed): it stays enabled, so a double-click double-submits.
  if (window.__FIXED) uploadBtn.disabled = true;
  try {
    const res = await fetch(`/api/loads/${loadId}/pods`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: chosenFile.name,
        bytes: chosenFile.size,
        notes: notesInput.value,
      }),
    });
    if (res.ok) {
      showToast("Upload received");
    } else {
      const body = await res.json().catch(() => ({}));
      showToast(body.error === "duplicate" ? "Already uploaded" : "Upload failed");
    }
  } catch {
    showToast("Upload failed");
  } finally {
    if (window.__FIXED) uploadBtn.disabled = false;
  }
  refreshPods();
}

uploadBtn.addEventListener("click", submit);

loadDetails();
refreshPods();
