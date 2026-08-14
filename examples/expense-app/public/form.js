/* Cove new-expense form. The planted bug lives in closeModal(). */

const descriptionInput = document.getElementById("description");
const amountInput = document.getElementById("amount");
const categorySelect = document.getElementById("category");
const noteBtn = document.getElementById("note-btn");
const notePreview = document.getElementById("note-preview");
const submitBtn = document.getElementById("submit-btn");
const modal = document.getElementById("note-modal");
const noteText = document.getElementById("note-text");
const noteSave = document.getElementById("note-save");
const noteCancel = document.getElementById("note-cancel");
const toast = document.getElementById("toast");

// The form's JS state — this, not the DOM, is what gets submitted.
const formState = { category: "uncategorized", note: "" };

categorySelect.addEventListener("change", () => {
  formState.category = categorySelect.value;
});

function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, 4000);
}

function openModal() {
  modal.hidden = false;
  noteText.focus();
}

function closeModal() {
  modal.hidden = true;
  // PLANTED BUG: the modal resets the WHOLE form state object, silently
  // clobbering the category the user already picked. The <select> element
  // still displays their choice, so nothing looks wrong — but the request
  // will carry "uncategorized".
  if (window.__FIXED) {
    formState.note = noteText.value;           // touch only what this modal owns
  } else {
    formState.category = "uncategorized";
    formState.note = noteText.value;
  }
}

noteBtn.addEventListener("click", openModal);
noteCancel.addEventListener("click", () => { noteText.value = formState.note; closeModal(); });
noteSave.addEventListener("click", () => {
  closeModal();
  notePreview.textContent = formState.note ? "Note added" : "";
});

submitBtn.addEventListener("click", async () => {
  const payload = {
    description: descriptionInput.value,
    amount: amountInput.value,
    category: formState.category,
    note: formState.note,
  };
  try {
    const res = await fetch("/api/expenses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      showToast("Expense submitted");
      setTimeout(() => { location.href = "/"; }, 900);
    } else {
      const body = await res.json().catch(() => ({}));
      showToast("Could not submit: " + (body.error || res.status));
    }
  } catch {
    showToast("Could not submit");
  }
});
