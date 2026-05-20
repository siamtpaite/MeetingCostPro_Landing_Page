#!/usr/bin/env python3
"""One-shot generator for MeetingCost docs HTML pages."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SIDEBAR_SECTIONS = [
    ("Getting Started", [
        ("overview.html", "📊", "Overview", False),
        ("getting-started.html", "🚀", "Free Version & Trial", False),
        ("license.html", "🔑", "Licenses & Login", False),
    ]),
    ("Pro Features", [
        ("ai-insights.html", "🤖", "AI Insights", True),
        ("cost-trends.html", "📈", "Cost Trends", True),
        ("recurring-patterns.html", "🔁", "Recurring Patterns", True),
        ("calendar.html", "📅", "Calendar", True),
        ("webhook-alerts.html", "🔔", "Webhook Alerts", True),
        ("team-preview.html", "👥", "Team Preview", True),
    ]),
    ("Data & Settings", [
        ("meeting-history.html", "📋", "Meeting History", False),
        ("export.html", "📤", "Export", True),
        ("settings.html", "⚙️", "Settings", False),
    ]),
]


def sidebar(active: str) -> str:
    parts = ['<nav class="docs-sidebar">']
    for title, links in SIDEBAR_SECTIONS:
        parts.append(f'    <div class="sidebar-section">')
        parts.append(f'      <div class="sidebar-section-title">{title}</div>')
        for href, icon, label, pro in links:
            cls = "sidebar-link active" if href == active else "sidebar-link"
            badge = ' <span class="sidebar-pro-badge">PRO</span>' if pro else ""
            parts.append(
                f'      <a class="{cls}" href="{href}">'
                f'<span class="icon">{icon}</span> {label}{badge}</a>'
            )
        parts.append("    </div>")
    parts.append("  </nav>")
    return "\n".join(parts)


def page(title: str, active: str, body: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>{title} — MeetingCost Docs</title>
<link rel="stylesheet" href="meetingcost-fonts.css"/>
<link rel="stylesheet" href="_shared.css"/>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
<nav class="topnav">
  <div class="topnav-logo">💸 MeetingCost <span>Docs</span></div>
  <div class="topnav-links">
    <a href="https://meetingcostpro.com/">Home</a>
    <a href="/privacy.html">Security &amp; Privacy</a>
    <a href="/terms.html">Terms of Service</a>
    <a href="https://chromewebstore.google.com/detail/meetingcost/afpbfdahhacahcbkfmpmbimnnecflngn" target="_blank" rel="noopener">Install Extension</a>
    <a href="mailto:siam_t_paite@meetingcostpro.com">Support</a>
  </div>
</nav>
<div class="docs-layout">
{sidebar(active)}
  <main class="docs-main">
    <div class="bg-gray-800 rounded-xl p-8 border border-gray-700 shadow-lg">
{body}
    </div>
  </main>
</div>
<footer class="docs-footer">
  <p>© 2026 MeetingCost. All rights reserved.</p>
  <div class="footer-links">
    <a href="https://meetingcostpro.com/">Home</a>
    <a href="/privacy.html">Security &amp; Privacy</a>
    <a href="/terms.html">Terms of Service</a>
    <a href="mailto:siam_t_paite@meetingcostpro.com">Support</a>
  </div>
</footer>
</body>
</html>
"""


def main():
    bodies_dir = ROOT / "docs-bodies"
    if not bodies_dir.is_dir():
        raise SystemExit(f"Missing {bodies_dir} — run from repo with docs-bodies/*.html")
    pages = [
        ("Overview", "overview.html", "overview.html"),
        ("Free Version & Trial", "getting-started.html", "getting-started.html"),
        ("Licenses & Login", "license.html", "license.html"),
        ("AI Insights", "ai-insights.html", "ai-insights.html"),
        ("Cost Trends", "cost-trends.html", "cost-trends.html"),
        ("Recurring Patterns", "recurring-patterns.html", "recurring-patterns.html"),
        ("Calendar", "calendar.html", "calendar.html"),
        ("Webhook Alerts", "webhook-alerts.html", "webhook-alerts.html"),
        ("Team Preview", "team-preview.html", "team-preview.html"),
        ("Meeting History", "meeting-history.html", "meeting-history.html"),
        ("Export", "export.html", "export.html"),
        ("Settings", "settings.html", "settings.html"),
    ]
    for doc_title, filename, active in pages:
        body_path = bodies_dir / f"{filename.replace('.html', '')}.body.html"
        body = body_path.read_text(encoding="utf-8").strip()
        out = ROOT / filename
        out.write_text(page(doc_title, active, body), encoding="utf-8")
        print(f"Wrote {out.name}")


if __name__ == "__main__":
    main()
