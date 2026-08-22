/**
 * MeetingCost PRO — web stablecoin checkout.
 *
 * Flow: sign in → pick plan/network → send stablecoins to the vault → this page
 * polls /api/poll-payment until the transfer lands → /api/register-crypto-license
 * verifies the tx on-chain, records the license, and emails the receipt → the
 * buyer is redirected to receipt.html with the key.
 *
 * Both API routes are gated by requireAuth/resolveIdentity, so a Firebase ID
 * token is mandatory — hence the sign-in step. register-crypto-license binds
 * the license to the *verified* account email and ignores any body-supplied
 * email, so the signed-in address is the license address by construction. That
 * is why there is no separate "email for license" field: it could only ever
 * disagree with the value the server actually uses.
 */
(function () {
  "use strict";

  // Same-origin paths on purpose. vercel.json rewrites /api/* to the backend
  // project server-side, so these never become cross-origin requests. Absolute
  // https://meetingcostpro.com/... URLs would work in production and fail on
  // every preview deployment, because the API pins Access-Control-Allow-Origin
  // to the production host and CORS_ALLOW_ORIGINS holds one origin, not a list.
  const POLL_URL = "/api/poll-payment";
  const REGISTER_URL = "/api/register-crypto-license";
  const SESSION_URL = "/api/create-payment-session";
  const PROJECT_ID = "meetingcost-auth";

  // Display only. The amount actually charged is quoted by
  // /api/create-payment-session and must match api/_lib/payment-session.js —
  // these numbers never reach the server.
  const USD_MONTHLY = 15.99;
  const USD_YEARLY = 159.99;
  const CARD_MONTHLY = 19.99;
  const CARD_YEARLY = 199.99;
  /** Same Gumroad products the extension's purchase page links to. */
  const GUMROAD_URL = {
    monthly: "https://siamtpaite.gumroad.com/l/xjguw",
    yearly: "https://siamtpaite.gumroad.com/l/uliny",
  };
  /** Watcher lifetime, matched to the extension's original 35-minute window. */
  const SESSION_MS = 35 * 60 * 1000;
  /** Tolerance for the buyer's clock running ahead of the chain's timestamps. */
  const CLOCK_SKEW_MS = 120_000;
  const SESSION_KEY = "meetingCostCryptoSession";

  const NETWORK_LOWER_TO_UPPER = { tron: "TRON", sol: "SOL", base: "BASE" };
  const NETWORK_LABEL = { tron: "Tron", sol: "Solana", base: "Base" };

  const $ = (id) => document.getElementById(id);

  // ── Element handles ────────────────────────────────────────────────────────
  const els = {
    trialOffer: $("trial-offer"),
    trialSpent: $("trial-spent"),
    usageFill: $("usage-fill"),
    usageLine: $("usage-line"),
    usageFacts: $("usage-facts"),
    methodCardBtn: $("method-card-btn"),
    methodCryptoBtn: $("method-crypto-btn"),
    cardPanel: $("card-panel"),
    cryptoPanel: $("crypto-panel"),
    gumroadLink: $("gumroad-link"),
    promoBadge: $("promo-badge"),
    priceMonthly: $("price-monthly"),
    priceYearly: $("price-yearly"),
    wasMonthly: $("was-monthly"),
    wasYearly: $("was-yearly"),
    signedOut: $("auth-signed-out"),
    signedIn: $("auth-signed-in"),
    signedInEmail: $("signed-in-email"),
    verifyGate: $("verify-gate"),
    verifyMessage: $("verify-message"),
    verifySend: $("verify-send"),
    verifyRecheck: $("verify-recheck"),
    tabSignin: $("tab-signin"),
    tabSignup: $("tab-signup"),
    authEmail: $("auth-email"),
    authPassword: $("auth-password"),
    authError: $("auth-error"),
    authSubmit: $("auth-submit"),
    authReset: $("auth-reset"),
    authSignout: $("auth-signout"),
    planMonthly: $("plan-monthly"),
    planYearly: $("plan-yearly"),
    networkSelect: $("network-select"),
    startError: $("start-error"),
    startBtn: $("start-payment"),
    terminal: $("terminal"),
    terminalPlan: $("terminal-plan"),
    terminalAmount: $("terminal-amount"),
    qrBox: $("qr-box"),
    copyAmountValue: $("copy-amount-value"),
    copyAddressValue: $("copy-address-value"),
    copyAmountBtn: $("copy-amount-btn"),
    copyAddressBtn: $("copy-address-btn"),
    statusLine: $("status-line"),
    statusText: $("status-text"),
    warnToken: $("warn-token"),
    warnNetwork: $("warn-network"),
    cancelBtn: $("cancel-payment"),
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let authMode = "signin";
  let selectedPlan = "monthly";
  let selectedMethod = "card";
  let emailVerified = false;
  let session = null;
  let pollTimer = null;
  let expiryTimer = null;
  let fulfilling = false;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function show(el) { el?.classList.remove("is-hidden"); }
  function hide(el) { el?.classList.add("is-hidden"); }

  function setError(el, message) {
    if (!el) return;
    if (!message) {
      el.textContent = "";
      hide(el);
      return;
    }
    el.textContent = message;
    show(el);
  }

  function setStatus(message, kind) {
    if (els.statusText) els.statusText.textContent = message;
    if (!els.statusLine) return;
    els.statusLine.classList.remove("is-success", "is-error");
    if (kind === "success") els.statusLine.classList.add("is-success");
    if (kind === "error") els.statusLine.classList.add("is-error");
  }

  function isValidEmail(value) {
    const v = String(value || "").trim();
    return v.length > 3 && v.includes("@") && v.includes(".") && !/\s/.test(v);
  }

  function tokenForNetwork(networkLower) {
    return networkLower === "tron" ? "USDT" : "USDC";
  }

  async function copyText(text) {
    const value = String(text);
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
    return new Promise((resolve, reject) => {
      try {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        resolve();
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  function flashCopied(btn) {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = original; }, 2000);
  }

  /**
   * Rendered locally with vendor/qrcode.min.js rather than a hosted QR service.
   * A remote generator would mean handing the vault address to a third party on
   * a page whose whole premise is that no third party sits in the transaction.
   */
  function renderQr(container, text, size) {
    if (!container) return;
    container.innerHTML = "";
    container.classList.remove("is-fallback");

    if (typeof QRCode !== "function") {
      container.classList.add("is-fallback");
      container.innerHTML =
        '<p class="qr-fallback">QR unavailable — copy the address below instead.</p>';
      return;
    }
    try {
      new QRCode(container, {
        text,
        width: size,
        height: size,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M,
      });
    } catch (_) {
      container.classList.add("is-fallback");
      container.innerHTML =
        '<p class="qr-fallback">QR unavailable — copy the address below instead.</p>';
    }
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  function setAuthMode(mode) {
    authMode = mode === "signup" ? "signup" : "signin";
    const isSignup = authMode === "signup";
    els.tabSignin?.classList.toggle("active", !isSignup);
    els.tabSignup?.classList.toggle("active", isSignup);
    els.tabSignin?.setAttribute("aria-selected", String(!isSignup));
    els.tabSignup?.setAttribute("aria-selected", String(isSignup));
    if (els.authSubmit) els.authSubmit.textContent = isSignup ? "Create account" : "Sign in";
    if (els.authPassword) {
      els.authPassword.autocomplete = isSignup ? "new-password" : "current-password";
    }
    setError(els.authError, "");
  }

  function renderSignedIn(email) {
    if (els.signedInEmail) els.signedInEmail.textContent = email;
    hide(els.signedOut);
    show(els.signedIn);
  }

  function renderSignedOut() {
    show(els.signedOut);
    hide(els.signedIn);
    hide(els.verifyGate);
    // Trial state belongs to whoever just signed out, so drop it with them.
    hide(els.trialSpent);
    show(els.trialOffer);
    emailVerified = false;
    if (els.signedInEmail) els.signedInEmail.textContent = "—";
  }

  // ── Trial status ───────────────────────────────────────────────────────────
  const FIRESTORE_DOC = (uid) =>
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/proLicenses/${encodeURIComponent(uid)}`;

  /** Unwrap one Firestore REST typed value into a plain JS value. */
  function fsValue(field) {
    if (!field || typeof field !== "object") return null;
    if ("stringValue" in field) return field.stringValue;
    if ("integerValue" in field) return Number(field.integerValue);
    if ("booleanValue" in field) return field.booleanValue;
    if ("doubleValue" in field) return Number(field.doubleValue);
    return null;
  }

  function formatDate(iso) {
    const t = Date.parse(String(iso || ""));
    if (!Number.isFinite(t)) return null;
    return new Date(t).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function formatMinutes(ms) {
    const mins = Math.round(Number(ms || 0) / 60000);
    return `${mins} minute${mins === 1 ? "" : "s"}`;
  }

  /**
   * Read this account's own proLicenses doc.
   *
   * Straight to Firestore rather than through /api: firestore.rules already lets
   * a user read proLicenses/{their own uid}, and unlike the purchase endpoints
   * that path does not require email_verified — which matters, because a
   * spent-trial account arriving here has usually never confirmed its address.
   */
  async function fetchTrialState(auth) {
    if (!auth?.idToken || !auth?.localId) return null;
    try {
      const res = await fetch(FIRESTORE_DOC(auth.localId), {
        headers: { Authorization: `Bearer ${auth.idToken}` },
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      const f = data?.fields;
      if (!f) return null;
      return {
        licenseKey: String(fsValue(f.licenseKey) || "").trim(),
        status: String(fsValue(f.trialStatus) || "").toLowerCase(),
        limitMs: fsValue(f.trialLimitMs) || 3600000,
        consumedMs: fsValue(f.trialConsumedMs) || 0,
        startedAt: fsValue(f.trialStartedAt),
        exhaustedAt: fsValue(f.trialExhaustedAt),
        exhaustedPermanently: fsValue(f.trialExhaustedPermanently) === true,
      };
    } catch (_) {
      return null;
    }
  }

  function renderTrialState(state) {
    const spent =
      !!state &&
      !state.licenseKey &&
      (state.status === "exhausted" || state.exhaustedPermanently === true);

    els.trialSpent?.classList.toggle("is-hidden", !spent);
    // Offering a trial to someone who just used theirs reads as a taunt.
    els.trialOffer?.classList.toggle("is-hidden", spent);
    if (!spent) return;

    const used = Math.min(Number(state.consumedMs) || 0, Number(state.limitMs) || 0);
    if (els.usageFill) {
      const pct = state.limitMs ? Math.min(100, (used / state.limitMs) * 100) : 100;
      els.usageFill.style.width = `${pct}%`;
    }
    if (els.usageLine) {
      els.usageLine.textContent = `${formatMinutes(used)} of ${formatMinutes(state.limitMs)} used`;
    }

    if (els.usageFacts) {
      const rows = [
        ["Trial started", formatDate(state.startedAt)],
        ["Hour ran out", formatDate(state.exhaustedAt)],
        ["Counted as", "Time the cost tracker was actually running"],
      ].filter(([, v]) => v);
      els.usageFacts.innerHTML = "";
      for (const [label, value] of rows) {
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = value;
        els.usageFacts.append(dt, dd);
      }
    }
  }

  /**
   * Reflect the account's email_verified state. The purchase endpoints reject
   * unverified tokens outright, so an unverified buyer must be stopped here
   * with an explanation rather than at a 401 they cannot interpret.
   */
  async function refreshVerifiedState(idToken) {
    emailVerified = await window.MeetingCostAuth.isEmailVerified(idToken);
    els.verifyGate?.classList.toggle("is-hidden", emailVerified);
    if (els.startBtn) els.startBtn.disabled = !emailVerified;
    return emailVerified;
  }

  async function handleSendVerification() {
    const auth = await currentSession();
    if (!auth?.idToken) return;
    els.verifySend.disabled = true;
    els.verifySend.textContent = "Sending…";
    try {
      const result = await window.MeetingCostAuth.sendVerificationEmail(auth.idToken);
      if (els.verifyMessage) {
        els.verifyMessage.textContent = result?.success
          ? `Confirmation link sent to ${auth.email}. Open it, then choose "I've confirmed".`
          : result?.error || "Could not send the confirmation link.";
        show(els.verifyMessage);
      }
    } finally {
      els.verifySend.disabled = false;
      els.verifySend.textContent = "Resend confirmation link";
    }
  }

  async function handleRecheckVerification() {
    els.verifyRecheck.disabled = true;
    els.verifyRecheck.textContent = "Checking…";
    try {
      // The email_verified claim only exists in a token minted after
      // confirmation, so the cached one must be replaced before re-checking.
      const refreshed = await window.MeetingCostAuth.forceRefreshSession();
      const ok = await refreshVerifiedState(refreshed?.idToken || "");
      if (els.verifyMessage) {
        els.verifyMessage.textContent = ok
          ? "Email confirmed — you can continue."
          : "Still not confirmed. Open the link in the email, then try again.";
        show(els.verifyMessage);
      }
    } finally {
      els.verifyRecheck.disabled = false;
      els.verifyRecheck.textContent = "I've confirmed — continue";
    }
  }

  async function currentSession() {
    return window.MeetingCostAuth?.ensureFreshSession
      ? await window.MeetingCostAuth.ensureFreshSession()
      : null;
  }

  async function handleAuthSubmit() {
    const email = String(els.authEmail?.value || "").trim();
    const password = String(els.authPassword?.value || "");
    setError(els.authError, "");

    if (!isValidEmail(email)) {
      setError(els.authError, "Enter a valid email address.");
      return;
    }
    if (password.length < 6) {
      setError(els.authError, "Password must be at least 6 characters.");
      return;
    }

    els.authSubmit.disabled = true;
    els.authSubmit.textContent = authMode === "signup" ? "Creating…" : "Signing in…";
    try {
      const result =
        authMode === "signup"
          ? await window.MeetingCostAuth.signUp(email, password)
          : await window.MeetingCostAuth.signIn(email, password);

      if (!result?.success) {
        setError(els.authError, result?.error || "Authentication failed.");
        return;
      }
      if (els.authPassword) els.authPassword.value = "";
      renderSignedIn(result.session.email || email.toLowerCase());
      renderTrialState(await fetchTrialState(result.session));
      const verified = await refreshVerifiedState(result.session.idToken);
      // A brand-new account is never verified, so send the link straight away
      // rather than making the buyer hunt for the button.
      if (!verified && authMode === "signup") await handleSendVerification();
    } finally {
      els.authSubmit.disabled = false;
      els.authSubmit.textContent = authMode === "signup" ? "Create account" : "Sign in";
    }
  }

  async function handlePasswordReset() {
    const email = String(els.authEmail?.value || "").trim();
    if (!isValidEmail(email)) {
      setError(els.authError, "Enter your email address above first, then click reset.");
      return;
    }
    const result = await window.MeetingCostAuth.sendPasswordResetEmail(email);
    setError(
      els.authError,
      result?.success ? "" : result?.error || "Could not send the reset email."
    );
    if (result?.success) {
      window.alert(`Password reset email sent to ${email}.`);
    }
  }

  // ── Payment session ────────────────────────────────────────────────────────
  function persistSession(record) {
    try {
      window.localStorage.setItem(SESSION_KEY, JSON.stringify(record));
    } catch (_) { /* non-fatal */ }
  }

  function clearPersistedSession() {
    try {
      window.localStorage.removeItem(SESSION_KEY);
    } catch (_) { /* non-fatal */ }
  }

  function readPersistedSession() {
    try {
      const raw = window.localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (!parsed.startedAt || Date.now() - parsed.startedAt > SESSION_MS) return null;
      if (!NETWORK_LOWER_TO_UPPER[parsed.network]) return null;
      // Sessions saved before the server started quoting amounts have no
      // sessionId; resuming one would poll with an undefined id and 400 forever.
      // Drop it and let the buyer start cleanly.
      if (!/^[0-9a-f]{32}$/i.test(String(parsed.sessionId || ""))) return null;
      if (parsed.expiresAt && Date.now() > Number(parsed.expiresAt)) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function stopWatching() {
    if (pollTimer != null) { clearInterval(pollTimer); pollTimer = null; }
    if (expiryTimer != null) { clearTimeout(expiryTimer); expiryTimer = null; }
  }

  function renderTerminal(record) {
    const config = window.PAYMENT_NETWORKS?.[NETWORK_LOWER_TO_UPPER[record.network]];
    const token = config?.token || tokenForNetwork(record.network);
    // 4 decimals: the trailing digits are the per-session identifier that ties this
  // transfer to this buyer. Rounding them off here would make the payment
  // unmatchable.
  const amountStr = Number(record.amount).toFixed(4);

    if (els.terminalPlan) {
      els.terminalPlan.textContent = record.plan === "yearly" ? "PRO Yearly" : "PRO Monthly";
    }
    if (els.terminalAmount) els.terminalAmount.textContent = `${amountStr} ${token}`;
    if (els.copyAmountValue) els.copyAmountValue.textContent = `${amountStr} ${token}`;
    if (els.copyAddressValue) els.copyAddressValue.textContent = record.vault;
    if (els.warnToken) els.warnToken.textContent = token;
    if (els.warnNetwork) els.warnNetwork.textContent = NETWORK_LABEL[record.network] || record.network;

    renderQr(els.qrBox, record.vault, 190);
    show(els.terminal);
    els.terminal?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function startPayment() {
    setError(els.startError, "");

    const auth = await currentSession();
    if (!auth?.idToken) {
      setError(els.startError, "Sign in above first — your license is issued to your account email.");
      renderSignedOut();
      return;
    }
    if (!(await refreshVerifiedState(auth.idToken))) {
      setError(
        els.startError,
        "Confirm your email address first — we can't issue a licence to an unconfirmed address."
      );
      return;
    }

    const network = String(els.networkSelect?.value || "tron").toLowerCase();
    const upper = NETWORK_LOWER_TO_UPPER[network];
    const config = upper ? window.PAYMENT_NETWORKS?.[upper] : null;
    const vault = String(config?.address || "").trim();

    if (!vault || /^YOUR_/i.test(vault)) {
      setError(els.startError, "This network is temporarily unavailable. Please pick another.");
      return;
    }

    const confirmMsg =
      `Confirm: your PRO license will be issued to ${auth.email}.\n\n` +
      "Crypto payments are non-refundable after the 48-hour window, so make sure this is the right account.";
    if (!window.confirm(confirmMsg)) return;

    // The amount is quoted by the server, not computed here. It carries a
    // per-session random cents offset, and that is the only thing that makes an
    // incoming transfer attributable to this buyer — the vault address is public
    // and every transfer to it is visible on-chain.
    els.startBtn.disabled = true;
    const previousLabel = els.startBtn.textContent;
    els.startBtn.textContent = "Preparing…";
    let quote;
    try {
      const res = await fetch(SESSION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.idToken}` },
        body: JSON.stringify({ plan: selectedPlan, network: NETWORK_LOWER_TO_UPPER[network] }),
      });
      quote = await res.json().catch(() => ({}));
      if (!res.ok || quote?.ok !== true) {
        setError(els.startError, quote?.error || `Could not start checkout (HTTP ${res.status}).`);
        return;
      }
    } catch (e) {
      setError(els.startError, `Could not start checkout: ${e?.message || "network error"}.`);
      return;
    } finally {
      els.startBtn.disabled = false;
      els.startBtn.textContent = previousLabel;
    }

    session = {
      sessionId: quote.sessionId,
      plan: quote.plan,
      network,
      vault: quote.vaultAddress || vault,
      amount: Number(quote.expectedAmount),
      email: auth.email,
      startedAt: Date.now(),
      expiresAt: Number(quote.expiresAt),
    };
    persistSession(session);
    renderTerminal(session);
    beginWatching();
  }

  function beginWatching() {
    stopWatching();
    if (!session) return;

    fulfilling = false;
    setStatus("Watching the chain for your transfer…");

    const upper = NETWORK_LOWER_TO_UPPER[session.network];
    const pollMs = window.PAYMENT_NETWORKS?.[upper]?.pollMs || 10_000;

    pollTimer = setInterval(() => { void tick(); }, pollMs);
    void tick();

    const elapsed = Date.now() - session.startedAt;
    expiryTimer = setTimeout(() => {
      stopWatching();
      clearPersistedSession();
      setStatus("Timed out after 35 minutes. If you already sent it, contact support with your transaction hash.", "error");
    }, Math.max(0, SESSION_MS - elapsed));
  }

  async function tick() {
    if (!session || fulfilling) return;
    try {
      const auth = await currentSession();
      if (!auth?.idToken) {
        setStatus("Your session expired — sign in again to resume watching.", "error");
        stopWatching();
        renderSignedOut();
        return;
      }

      const res = await fetch(POLL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.idToken}`,
        },
        body: JSON.stringify({
          sessionId: session.sessionId,
          network: NETWORK_LOWER_TO_UPPER[session.network],
          vaultAddress: session.vault,
          contractAddress: null,
          // Narrow window as well as the session filter. The server only reports
          // a transfer matching this session's unique amount, so another buyer's
          // payment can no longer surface here at all.
          sinceMs: session.startedAt - CLOCK_SKEW_MS,
          limit: 10,
        }),
      });

      if (!res.ok) {
        setStatus(
          res.status === 401
            ? "Your session expired — sign in again to resume watching."
            : `Chain check failed (HTTP ${res.status}). Retrying…`,
          "error"
        );
        return;
      }

      const data = await res.json().catch(() => ({ found: false }));
      if (data?.found === true && data.txHash) {
        fulfilling = true;
        stopWatching();
        setStatus("Payment detected. Issuing your license…", "success");
        await fulfill(String(data.txHash), auth.idToken);
        return;
      }

      const time = new Date().toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
      setStatus(`Last chain check ${time} — no payment seen yet.`);
    } catch (e) {
      setStatus(`Chain check failed: ${e?.message || "network error"}. Retrying…`, "error");
    }
  }

  async function fulfill(txHash, idToken) {
    try {
      // Plan, price and licence key all come from the server-held session now.
      // Sending them from here is what allowed paying one plan's price and
      // claiming another, and let the caller choose the licence key.
      const res = await fetch(REGISTER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ sessionId: session.sessionId, txHash }),
      });

      const data = await res.json().catch(() => ({}));
      const licenseKey = String(data?.licenseKey || "");

      // A chain lookup that could not complete is not a refusal. Keep watching
      // rather than telling someone who has already paid that it failed.
      if (res.status === 503 || data?.retryable === true) {
        fulfilling = false;
        setStatus(
          data?.error || "Could not reach the blockchain just now — still trying. Keep this page open.",
          "error"
        );
        beginWatching();
        return;
      }

      if (!res.ok || data?.ok !== true) {
        fulfilling = false;
        const detail = data?.error || `HTTP ${res.status}`;
        setStatus(
          `Payment seen, but the license could not be issued (${detail}). Contact support with transaction ${txHash} — do not pay again.`,
          "error"
        );
        return;
      }

      clearPersistedSession();
      const params = new URLSearchParams({
        status: "success",
        email: session.email,
        key: licenseKey,
        plan: session.plan,
      });
      window.location.href = `/receipt.html?${params.toString()}`;
    } catch (e) {
      fulfilling = false;
      setStatus(
        `Payment seen, but the license request failed (${e?.message || "network error"}). Contact support with transaction ${txHash} — do not pay again.`,
        "error"
      );
    }
  }

  function cancelPayment() {
    stopWatching();
    clearPersistedSession();
    session = null;
    hide(els.terminal);
    if (els.qrBox) els.qrBox.innerHTML = "";
    setStatus("Watching the chain for your transfer…");
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  function selectPlan(plan) {
    selectedPlan = plan === "yearly" ? "yearly" : "monthly";
    const isYearly = selectedPlan === "yearly";
    els.planMonthly?.classList.toggle("selected", !isYearly);
    els.planYearly?.classList.toggle("selected", isYearly);
    els.planMonthly?.setAttribute("aria-pressed", String(!isYearly));
    els.planYearly?.setAttribute("aria-pressed", String(isYearly));
    if (els.gumroadLink) els.gumroadLink.href = GUMROAD_URL[selectedPlan];
  }

  /**
   * Card and crypto are priced differently (crypto is 20% off), so the plan
   * cards restate their prices when the method changes rather than showing one
   * price and charging another.
   */
  function selectMethod(method) {
    selectedMethod = method === "crypto" ? "crypto" : "card";
    const isCrypto = selectedMethod === "crypto";

    document.body.setAttribute("data-method", selectedMethod);
    els.methodCardBtn?.classList.toggle("selected", !isCrypto);
    els.methodCryptoBtn?.classList.toggle("selected", isCrypto);
    els.methodCardBtn?.setAttribute("aria-pressed", String(!isCrypto));
    els.methodCryptoBtn?.setAttribute("aria-pressed", String(isCrypto));

    if (els.priceMonthly) {
      els.priceMonthly.textContent = `$${(isCrypto ? USD_MONTHLY : CARD_MONTHLY).toFixed(2)}`;
    }
    if (els.priceYearly) {
      els.priceYearly.textContent = `$${(isCrypto ? USD_YEARLY : CARD_YEARLY).toFixed(2)}`;
    }
    els.wasMonthly?.classList.toggle("is-hidden", !isCrypto);
    els.wasYearly?.classList.toggle("is-hidden", !isCrypto);
    els.promoBadge?.classList.toggle("is-hidden", !isCrypto);

    els.cardPanel?.classList.toggle("is-hidden", isCrypto);
    els.cryptoPanel?.classList.toggle("is-hidden", !isCrypto);

    // Switching away from crypto must not leave a watcher running in the
    // background against a session the buyer can no longer see.
    if (!isCrypto && session) cancelPayment();
  }

  els.tabSignin?.addEventListener("click", () => setAuthMode("signin"));
  els.tabSignup?.addEventListener("click", () => setAuthMode("signup"));
  els.authSubmit?.addEventListener("click", () => void handleAuthSubmit());
  els.authReset?.addEventListener("click", () => void handlePasswordReset());
  els.authPassword?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void handleAuthSubmit();
  });
  els.verifySend?.addEventListener("click", () => void handleSendVerification());
  els.verifyRecheck?.addEventListener("click", () => void handleRecheckVerification());
  els.authSignout?.addEventListener("click", () => {
    window.MeetingCostAuth.signOut();
    cancelPayment();
    renderSignedOut();
  });

  els.methodCardBtn?.addEventListener("click", () => selectMethod("card"));
  els.methodCryptoBtn?.addEventListener("click", () => selectMethod("crypto"));
  els.planMonthly?.addEventListener("click", () => selectPlan("monthly"));
  els.planYearly?.addEventListener("click", () => selectPlan("yearly"));
  els.startBtn?.addEventListener("click", () => void startPayment());
  els.cancelBtn?.addEventListener("click", cancelPayment);

  els.copyAmountBtn?.addEventListener("click", async () => {
    if (!session) return;
    try {
      await copyText(Number(session.amount).toFixed(4));
      flashCopied(els.copyAmountBtn);
    } catch (_) { /* clipboard denied — the value is visible on screen anyway */ }
  });

  els.copyAddressBtn?.addEventListener("click", async () => {
    if (!session) return;
    try {
      await copyText(session.vault);
      flashCopied(els.copyAddressBtn);
    } catch (_) { /* clipboard denied — the value is visible on screen anyway */ }
  });

  window.addEventListener("pagehide", stopWatching);

  // ── Boot ───────────────────────────────────────────────────────────────────
  (async function init() {
    setAuthMode("signin");
    selectPlan("monthly");

    // ?method=crypto lets the landing page's "Pay with Crypto" CTA land the
    // buyer directly on the path they clicked.
    const wanted = new URLSearchParams(window.location.search).get("method");
    selectMethod(wanted === "crypto" ? "crypto" : "card");

    const auth = await currentSession();
    if (auth?.email) {
      renderSignedIn(auth.email);
      renderTrialState(await fetchTrialState(auth));
      await refreshVerifiedState(auth.idToken);
    } else {
      renderSignedOut();
    }

    // Resume an in-flight checkout across a reload, so a buyer who refreshes
    // after sending funds keeps the same watch window instead of restarting it.
    const saved = readPersistedSession();
    if (saved && auth?.idToken) {
      session = saved;
      selectMethod("crypto");
      selectPlan(saved.plan);
      if (els.networkSelect) els.networkSelect.value = saved.network;
      renderTerminal(saved);
      beginWatching();
    }
  })();
})();
