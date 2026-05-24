# ⚠️ CRITICAL — DO NOT CHANGE WITHOUT FULL UNDERSTANDING

This file documents the essential configuration in the MeetingCost landing
page repo (`MeetingCostPro_Landing_Page`). Changing the items below WILL
break license verification and API access for all extension users.

---

## 1. `vercel.json` — API Proxy — THE MOST CRITICAL FILE IN THIS REPO

```json
{
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://meetingcost-success-git-main-siamtpaite.vercel.app/api/:path*"
    },
    {
      "source": "/((?!api/).*)",
      "destination": "/index.html"
    }
  ]
}
```

**DO NOT remove or modify the `/api/:path*` rewrite.**

The MeetingCost extension calls `meetingcostpro.com/api/verify-license` for
all license verification. The `meetingcostpro.com` domain lives in THIS repo
(the frontend), but the actual API functions live in `meetingcost-success`.

This proxy rewrite is what connects them. Without it, every API call returns
404 and ALL users get "License verification failed" on login.

This was broken and took hours to diagnose on May 24, 2026. The fix was
adding this proxy. Never remove it.

---

## 2. Domain Assignment

`meetingcostpro.com` and `www.meetingcostpro.com` are assigned to THIS
Vercel project (`meetingcostpro`). Do not move these domains to
`meetingcost-success` or any other project without updating the proxy
destination URL accordingly.

---

## 3. Vercel Dashboard — No Build Overrides

In the Vercel dashboard for this project, all build setting overrides
(Build Command, Output Directory, Install Command) must remain **OFF**.
Enabling any override can break static file serving.

---

## 4. API Endpoints Proxied Through This Domain

All of these are critical for extension functionality:

| Endpoint | Purpose |
|----------|---------|
| `/api/verify-license` | Crypto + Gumroad license verification on login |
| `/api/register-crypto-license` | Post-payment license registration |
| `/api/poll-payment` | Crypto payment confirmation polling |
| `/api/send-webhook` | Slack/Teams budget alert delivery |
| `/api/auth/resolve-username` | Username → email resolution on login |
| `/api/cron/weekly-digest` | Weekly email digest (cron) |
| `/api/outlook-token` | Outlook Calendar OAuth token exchange |

---

## Last updated: May 24, 2026
