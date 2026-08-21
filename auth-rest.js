/**
 * Firebase Auth via REST — web port of the extension's firebase-auth-rest.js.
 *
 * Deliberately REST rather than the Firebase Web SDK: this site's CSP is
 * `script-src 'self' 'unsafe-inline'`, which blocks the gstatic CDN bundle
 * outright. REST needs only fetch(), and `connect-src 'self' https:` allows it.
 *
 * Only difference from the extension version: session persistence uses
 * localStorage instead of chrome.storage.local (same record shape, so the two
 * stay conceptually in sync).
 */
(function () {
  "use strict";

  const STORAGE_KEY = "meetingCostFirebaseAuth";
  const IDENTITY = "https://identitytoolkit.googleapis.com/v1";
  const SECURE_TOKEN = "https://securetoken.googleapis.com/v1";

  function getConfig() {
    return typeof window !== "undefined" ? window.MeetingCostFirebaseConfig : null;
  }

  function isConfigured() {
    const c = getConfig();
    return !!(c && typeof c.apiKey === "string" && c.apiKey.length >= 20);
  }

  function mapError(data) {
    const msg = String(data?.error?.message || "");
    if (msg.includes("EMAIL_EXISTS")) return "This email already has an account — sign in instead.";
    if (msg.includes("WEAK_PASSWORD")) return "Password should be at least 6 characters.";
    if (msg.includes("EMAIL_NOT_FOUND")) return "No account found for this email.";
    if (msg.includes("INVALID_PASSWORD") || msg.includes("INVALID_LOGIN_CREDENTIALS"))
      return "Wrong email or password.";
    if (msg.includes("INVALID_EMAIL")) return "Invalid email address.";
    if (msg.includes("USER_DISABLED")) return "This account has been disabled.";
    if (msg.includes("TOO_MANY_ATTEMPTS")) return "Too many attempts. Please wait and try again.";
    return msg.replace(/_/g, " ") || "Authentication failed.";
  }

  // Private-mode Safari and blocked-cookie setups throw on localStorage access
  // rather than returning null, so every read/write is guarded.
  function readStoredSession() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function writeSession(rec) {
    try {
      if (!rec) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rec));
    } catch (_) {
      /* non-fatal: the session simply won't survive a reload */
    }
  }

  async function refreshTokens(refreshToken) {
    const apiKey = getConfig()?.apiKey;
    if (!apiKey) throw new Error("Firebase is not configured.");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const res = await fetch(`${SECURE_TOKEN}/token?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      writeSession(null);
      throw new Error(data.error?.message || "Session expired. Sign in again.");
    }
    return {
      idToken: data.id_token,
      refreshToken: data.refresh_token || refreshToken,
      localId: data.user_id,
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
    };
  }

  /** Refresh the idToken if it is missing or near expiry. */
  async function ensureFreshSession() {
    if (!isConfigured()) return null;
    let s = readStoredSession();
    if (!s?.refreshToken) return null;
    const skew = 120_000;
    if (s.expiresAt && Date.now() < s.expiresAt - skew) return s;
    try {
      const next = await refreshTokens(s.refreshToken);
      s = {
        ...s,
        idToken: next.idToken,
        refreshToken: next.refreshToken,
        localId: next.localId || s.localId,
        expiresAt: next.expiresAt,
      };
      writeSession(s);
      return s;
    } catch (_) {
      return null;
    }
  }

  function sessionFromSignPayload(data, fallbackEmail) {
    return {
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      localId: data.localId,
      email: String(data.email || fallbackEmail || "").trim().toLowerCase(),
      expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000,
    };
  }

  async function post(path, payload) {
    const apiKey = getConfig().apiKey;
    const res = await fetch(`${IDENTITY}/${path}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function signUp(email, password) {
    if (!isConfigured()) return { success: false, error: "Firebase is not configured." };
    const norm = String(email ?? "").trim();
    try {
      const { res, data } = await post("accounts:signUp", {
        email: norm,
        password,
        returnSecureToken: true,
      });
      if (!res.ok || data.error) {
        writeSession(null);
        return { success: false, error: mapError(data) };
      }
      const session = sessionFromSignPayload(data, norm);
      writeSession(session);
      return { success: true, session };
    } catch (e) {
      writeSession(null);
      return { success: false, error: e?.message || "Authentication failed." };
    }
  }

  async function signIn(email, password) {
    if (!isConfigured()) return { success: false, error: "Firebase is not configured." };
    const norm = String(email ?? "").trim();
    try {
      const { res, data } = await post("accounts:signInWithPassword", {
        email: norm,
        password,
        returnSecureToken: true,
      });
      if (!res.ok || data.error) {
        writeSession(null);
        return { success: false, error: mapError(data) };
      }
      const session = sessionFromSignPayload(data, norm);
      writeSession(session);
      return { success: true, session };
    } catch (e) {
      writeSession(null);
      return { success: false, error: e?.message || "Authentication failed." };
    }
  }

  function signOut() {
    writeSession(null);
    return { success: true };
  }

  /**
   * Whether this account's email address is verified.
   *
   * This gates real money: api/_lib/auth.js rejects any ID token whose
   * email_verified claim is not true, so poll-payment and
   * register-crypto-license both 401 for an unverified account. Password signup
   * never sets the claim, so it has to be earned explicitly.
   */
  async function isEmailVerified(idToken) {
    if (!isConfigured() || !idToken) return false;
    try {
      const { res, data } = await post("accounts:lookup", { idToken });
      if (!res.ok || data.error) return false;
      return data?.users?.[0]?.emailVerified === true;
    } catch (_) {
      return false;
    }
  }

  async function sendVerificationEmail(idToken) {
    if (!isConfigured()) return { success: false, error: "Firebase is not configured." };
    if (!idToken) return { success: false, error: "Sign in first." };
    try {
      const { res, data } = await post("accounts:sendOobCode", {
        requestType: "VERIFY_EMAIL",
        idToken,
      });
      if (!res.ok || data.error) return { success: false, error: mapError(data) };
      return { success: true };
    } catch (e) {
      return { success: false, error: e?.message || "Could not send the verification email." };
    }
  }

  /**
   * Unconditionally exchange the refresh token for a new ID token.
   * Needed after the buyer verifies: the email_verified claim only appears in a
   * token minted after verification, so the cached one stays stale and the API
   * keeps returning 401.
   */
  async function forceRefreshSession() {
    if (!isConfigured()) return null;
    const s = readStoredSession();
    if (!s?.refreshToken) return null;
    try {
      const next = await refreshTokens(s.refreshToken);
      const merged = {
        ...s,
        idToken: next.idToken,
        refreshToken: next.refreshToken,
        localId: next.localId || s.localId,
        expiresAt: next.expiresAt,
      };
      writeSession(merged);
      return merged;
    } catch (_) {
      return null;
    }
  }

  async function sendPasswordResetEmail(email) {
    if (!isConfigured()) return { success: false, error: "Firebase is not configured." };
    const normalized = String(email || "").trim().toLowerCase();
    if (!normalized || !normalized.includes("@")) {
      return { success: false, error: "Enter a valid email address." };
    }
    try {
      const { res, data } = await post("accounts:sendOobCode", {
        requestType: "PASSWORD_RESET",
        email: normalized,
      });
      if (!res.ok) return { success: false, error: mapError(data) };
      return { success: true };
    } catch (e) {
      return { success: false, error: e?.message || "Failed to send reset email." };
    }
  }

  window.MeetingCostAuth = {
    isConfigured,
    signUp,
    signIn,
    signOut,
    sendPasswordResetEmail,
    isEmailVerified,
    sendVerificationEmail,
    ensureFreshSession,
    forceRefreshSession,
    getStoredSession: readStoredSession,
    STORAGE_KEY,
  };
})();
