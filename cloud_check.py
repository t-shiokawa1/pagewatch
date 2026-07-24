#!/usr/bin/env python3
"""PageWatch cloud checker: runs inside GitHub Actions on the private data repo.

Reads sites.json / state.json from the data repo (current directory), checks
sites that are due, and writes the updated state.json back. Change detection
reuses the exact same logic as the local server (server.py) so both modes
behave identically. Email notification uses SMTP_* environment variables
provided as Actions secrets; desktop notification is not available here.

Usage:
    python cloud_check.py [--data DIR] [--only SITE_ID] [--all]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# server.py lives next to this file (the app repo checkout).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402

MIN_INTERVAL = 30
DEFAULT_INTERVAL = 60
MAX_EVENTS = 100


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def load_json(path: Path, fallback: Any) -> Any:
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def email_settings() -> Dict[str, Any]:
    return {
        "email_enabled": bool(os.environ.get("SMTP_HOST") and os.environ.get("EMAIL_TO")),
        "email_to": os.environ.get("EMAIL_TO", ""),
        "smtp_host": os.environ.get("SMTP_HOST", ""),
        "smtp_port": int(os.environ.get("SMTP_PORT", "587") or 587),
        "smtp_user": os.environ.get("SMTP_USER", ""),
        "smtp_password": os.environ.get("SMTP_PASSWORD", ""),
        "smtp_from": os.environ.get("SMTP_FROM", ""),
        "smtp_ssl": os.environ.get("SMTP_SSL", "") == "1",
    }


def is_due(site: Dict[str, Any], entry: Dict[str, Any]) -> bool:
    if not site.get("enabled", True):
        return False
    last = parse_iso(entry.get("last_checked"))
    if last is None:
        return True
    interval = max(MIN_INTERVAL, int(site.get("interval_minutes") or DEFAULT_INTERVAL))
    return (datetime.now(timezone.utc) - last).total_seconds() >= interval * 60 - 90


def add_event(state: Dict[str, Any], site: Dict[str, Any], kind: str, summary: str) -> None:
    events: List[Dict[str, Any]] = state.setdefault("events", [])
    updates: List[Dict[str, Any]] = state.setdefault("updates", [])
    next_id = 1 + max((e.get("id", 0) for e in [*events, *updates]), default=0)
    event = {
        "id": next_id,
        "site_id": site["id"],
        "site_name": site.get("name") or site["url"],
        "kind": kind,
        "summary": summary,
        "created_at": now_iso(),
    }
    events.insert(0, event)
    # The activity feed is deliberately short, but a detected update and its
    # diff are permanent history. Never let routine checks hide that content.
    if kind == "changed":
        updates.insert(0, event.copy())
    del events[MAX_EVENTS:]


def site_urls(site: Dict[str, Any]) -> List[str]:
    urls = site.get("urls") or []
    return list(dict.fromkeys([site["url"], *[str(url) for url in urls if isinstance(url, str)]]))


def check_page(url: str, previous: Dict[str, Any]) -> Tuple[str, Optional[str], Dict[str, Any], Optional[str]]:
    """Return outcome, summary, new state and a readable error for one URL."""
    fetch_input = {"url": url, "etag": previous.get("etag", ""), "last_modified": previous.get("last_modified", "")}
    try:
        html_text, headers = server.fetch_site(fetch_input)
        if headers.get("not_modified"):
            return "unchanged", None, previous, None
        snapshot = server.normalize_content(html_text, headers.get("content_type", "text/html"), url)
        if not snapshot:
            raise RuntimeError("比較できる表示内容が見つかりません")
        content_hash = hashlib.sha256(snapshot.encode("utf-8")).hexdigest()
        next_entry = {
            "etag": headers.get("etag", ""),
            "last_modified": headers.get("last_modified", ""),
            "content_hash": content_hash,
            "snapshot": snapshot,
        }
        if not previous.get("content_hash"):
            return "baseline", None, next_entry, None
        if previous.get("content_hash") == content_hash:
            return "unchanged", None, next_entry, None
        added, removed = server.content_change(previous.get("snapshot") or "", snapshot)
        if not added and not removed:
            return "unchanged", None, next_entry, None
        return "changed", server.summarize_changes(added, removed), next_entry, None
    except Exception as exc:
        return "error", None, previous, str(exc)[:500]


def check_one(site: Dict[str, Any], entry: Dict[str, Any], state: Dict[str, Any], mail: Dict[str, Any]) -> str:
    checked_at = now_iso()
    pages = entry.setdefault("pages", {})
    # Preserve the root baseline written by older cloud versions.
    if not pages and entry.get("content_hash"):
        pages[site["url"]] = {key: entry.get(key, "") for key in ("etag", "last_modified", "content_hash", "snapshot")}
    outcomes: List[str] = []
    changed_pages: List[Tuple[str, str]] = []
    errors: List[str] = []
    for url in site_urls(site):
        outcome, summary, next_page, error = check_page(url, pages.get(url, {}))
        pages[url] = next_page
        outcomes.append(outcome)
        if summary:
            changed_pages.append((url, summary))
        if error:
            errors.append(f"{url}: {error}")

    if changed_pages:
        outcome = "changed"
        summary = "\n\n".join(f"[{url}]\n{text}" for url, text in changed_pages)
    elif errors:
        outcome = "error"
        summary = errors[0]
    elif "baseline" in outcomes:
        outcome = "baseline"
        summary = f"{len(outcomes)}ページの初回の比較基準を保存しました"
    else:
        outcome = "unchanged"
        summary = ""
    checks = entry.get("checks")
    if not isinstance(checks, list):
        checks = []
    checks.insert(0, {
        "checked_at": checked_at,
        "status": outcome,
        "page_count": len(site_urls(site)),
    })
    entry.update(
        status=outcome,
        last_checked=checked_at,
        last_error=errors[0] if errors else None,
        pages=pages,
        checks=checks[:server.MAX_CHECK_HISTORY],
    )
    if outcome == "changed":
        entry["last_changed"] = checked_at
    if outcome in {"changed", "baseline", "error"}:
        add_event(state, site, outcome, summary)

    if outcome == "changed" and mail["email_enabled"]:
        try:
            server.send_email(
                mail,
                f"PageWatch更新: {site.get('name') or site['url']}",
                f"{site.get('name') or site['url']} が更新されました。\n{site['url']}\n\n{summary}",
            )
        except Exception as exc:
            add_event(state, site, "notification_error", f"通知に失敗しました: {exc}")
    return outcome


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default=".", help="data repo directory (sites.json / state.json)")
    parser.add_argument("--only", default="", help="check only this site id")
    parser.add_argument("--all", action="store_true", help="check every enabled site now")
    args = parser.parse_args()

    data_dir = Path(args.data).resolve()
    sites_path = data_dir / "sites.json"
    sites: List[Dict[str, Any]] = load_json(sites_path, [])
    state: Dict[str, Any] = load_json(data_dir / "state.json", {})
    state.setdefault("sites", {})
    state.setdefault("events", [])
    # Migrate history created before the dedicated update archive existed.
    # Older cloud files can only contribute the changes that were still in the
    # previous 100-item activity feed; future detected updates are unbounded.
    if not isinstance(state.get("updates"), list):
        state["updates"] = [
            event for event in state["events"]
            if isinstance(event, dict) and event.get("kind") == "changed"
        ]

    # Drop state for sites that were deleted from the list.
    known = {str(s["id"]) for s in sites}
    state["sites"] = {k: v for k, v in state["sites"].items() if k in known}

    mail = email_settings()
    results = []
    for site in sites:
        key = str(site["id"])
        entry = state["sites"].setdefault(key, {})
        if args.only and key != str(args.only):
            continue
        if not args.only and not args.all and not is_due(site, entry):
            continue
        if not site.get("enabled", True) and not args.only:
            continue
        if site.pop("auto_discover", False):
            # Only a newly added site is expanded automatically.  Existing
            # single-page records must keep their original scope instead of
            # unexpectedly starting to monitor every navigation link.
            try:
                discovered = server.discover_internal_urls(site["url"], int(site.get("discovery_depth", 0)))
                site["discovered_urls"] = discovered
                site["urls"] = discovered
            except Exception:
                site["urls"] = [site["url"]]
                site["discovered_urls"] = [site["url"]]
        elif not site.get("urls"):
            site["urls"] = [site["url"]]
        results.append((site.get("name") or site["url"], check_one(site, entry, state, mail)))

    state["last_run"] = now_iso()
    sites_path.write_text(json.dumps(sites, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (data_dir / "state.json").write_text(
        json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    for name, outcome in results:
        print(f"{outcome}: {name}")
    print(f"checked {len(results)} site(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
