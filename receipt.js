/**
 * Receipt page — renders the license key handed over by purchase.js.
 *
 * Web port of the extension's receipt.js. Values arrive as URL params and are
 * written with textContent (never innerHTML), so a crafted link cannot inject
 * markup into the page.
 */
(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const status = params.get("status") || "";
  const email = params.get("email") || "";
  const key = params.get("key") || "";

  const keyEl = document.getElementById("receipt-key");
  const emailLine = document.getElementById("receipt-email-line");
  const titleEl = document.getElementById("receipt-title");
  const messageEl = document.getElementById("receipt-message");
  const eyebrowEl = document.getElementById("receipt-eyebrow");
  const copyBtn = document.getElementById("copy-key-btn");

  const CRYPTO_KEY_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
  const keyNorm = String(key).trim().toUpperCase();
  const hasValidKey = CRYPTO_KEY_RE.test(keyNorm);

  if (keyEl) keyEl.textContent = hasValidKey ? keyNorm : "—";
  if (emailLine) emailLine.textContent = email ? `Issued to ${email}` : "Issued to —";

  if (status !== "success" || !hasValidKey) {
    // Reached without a real fulfillment redirect — say so plainly rather than
    // implying a purchase completed.
    if (eyebrowEl) eyebrowEl.textContent = "No receipt found";
    if (titleEl) titleEl.textContent = "Nothing to show here";
    if (messageEl) {
      messageEl.textContent =
        "This page displays a license key right after a completed purchase. Check your email for your key, or contact support if a payment went through.";
    }
    if (copyBtn) copyBtn.disabled = true;
  }

  copyBtn?.addEventListener("click", async () => {
    if (!hasValidKey) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(keyNorm);
      } else {
        const ta = document.createElement("textarea");
        ta.value = keyNorm;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      const original = copyBtn.textContent;
      copyBtn.textContent = "Copied";
      setTimeout(() => { copyBtn.textContent = original; }, 2000);
    } catch (_) {
      /* clipboard denied — the key is selectable on screen */
    }
  });
})();
