#!/usr/bin/env python3
"""PageWatch local server: website monitoring, SQLite storage and JSON API."""

from __future__ import annotations

import argparse
from collections import Counter
import difflib
import hashlib
from html.parser import HTMLParser
import json
import logging
import mimetypes
import os
from pathlib import Path
import re
import smtplib
import sqlite3
import ssl
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from email.message import EmailMessage
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urljoin, urlparse
from urllib.request import Request, urlopen
import webbrowser


APP_DIR = Path(__file__).resolve().parent
DIST_DIR = APP_DIR / "dist"
DATA_DIR = APP_DIR / "data"
DB_PATH = DATA_DIR / "pagewatch.db"
SETTINGS_PATH = DATA_DIR / "settings.json"
LOG_PATH = DATA_DIR / "pagewatch.log"
HOST = "127.0.0.1"
PORT = 8765
APP_VERSION = "1.2.7"
USER_AGENT = "PageWatch/1.0 (local personal website monitor)"
DEFAULT_ALLOWED_ORIGINS = {
    "https://t-shiokawa1.github.io",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
}
MAX_PAGE_BYTES = 10 * 1024 * 1024
MAX_DISCOVERED_PAGES = 40
DISCOVERY_DEPTH = 2
MAX_CHECK_HISTORY = 20
SCHEDULER_POLL_SECONDS = 5
CHECK_LOCK = threading.Lock()
STOP_EVENT = threading.Event()


DEFAULT_SETTINGS: Dict[str, Any] = {
    "desktop_notifications": True,
    "email_enabled": False,
    "email_to": "",
    "smtp_host": "",
    "smtp_port": 587,
    "smtp_user": "",
    "smtp_password": "",
    "smtp_from": "",
    "smtp_ssl": False,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def db_connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def init_database() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with db_connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS sites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                url TEXT NOT NULL UNIQUE,
                interval_minutes INTEGER NOT NULL DEFAULT 15,
                enabled INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'waiting',
                last_checked TEXT,
                last_changed TEXT,
                last_error TEXT,
                etag TEXT,
                last_modified TEXT,
                content_hash TEXT,
                snapshot TEXT,
                urls_json TEXT,
                discovered_urls_json TEXT,
                discovery_depth INTEGER NOT NULL DEFAULT 0,
                page_states_json TEXT,
                check_history_json TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                site_id INTEGER NOT NULL,
                kind TEXT NOT NULL,
                summary TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS events_site_created
                ON events(site_id, created_at DESC);
            """
        )
        columns = {row[1] for row in db.execute("PRAGMA table_info(sites)")}
        if "urls_json" not in columns:
            db.execute("ALTER TABLE sites ADD COLUMN urls_json TEXT")
        if "discovered_urls_json" not in columns:
            db.execute("ALTER TABLE sites ADD COLUMN discovered_urls_json TEXT")
        if "discovery_depth" not in columns:
            db.execute("ALTER TABLE sites ADD COLUMN discovery_depth INTEGER NOT NULL DEFAULT 0")
        if "page_states_json" not in columns:
            db.execute("ALTER TABLE sites ADD COLUMN page_states_json TEXT")
        if "check_history_json" not in columns:
            db.execute("ALTER TABLE sites ADD COLUMN check_history_json TEXT")
        count = db.execute("SELECT COUNT(*) FROM sites").fetchone()[0]
        if count == 0:
            db.execute(
                """
                INSERT INTO sites (name, url, interval_minutes, enabled, status, created_at)
                VALUES (?, ?, ?, 1, 'waiting', ?)
                """,
                (
                    "Fukazawa Group",
                    "https://fukazawa.icems.kyoto-u.ac.jp/",
                    15,
                    now_iso(),
                ),
            )


def load_settings() -> Dict[str, Any]:
    settings = dict(DEFAULT_SETTINGS)
    if SETTINGS_PATH.exists():
        try:
            loaded = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                settings.update({key: value for key, value in loaded.items() if key in settings})
        except (OSError, json.JSONDecodeError):
            logging.exception("Could not read settings")
    return settings


def save_settings(incoming: Dict[str, Any]) -> Dict[str, Any]:
    current = load_settings()
    allowed = set(DEFAULT_SETTINGS)
    for key, value in incoming.items():
        if key not in allowed:
            continue
        if key == "smtp_password" and value == "":
            continue
        current[key] = value
    current["smtp_port"] = max(1, min(65535, int(current.get("smtp_port", 587))))
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp_path = SETTINGS_PATH.with_suffix(".tmp")
    temp_path.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(temp_path, 0o600)
    os.replace(temp_path, SETTINGS_PATH)
    return public_settings(current)


def public_settings(settings: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    result = dict(settings or load_settings())
    result["smtp_password_set"] = bool(result.get("smtp_password"))
    result["smtp_password"] = ""
    return result


class VisibleContentParser(HTMLParser):
    """Extract text and image references that represent visible page content."""

    ignored_tags = {
        "script",
        "style",
        "noscript",
        "template",
        "svg",
        "canvas",
        "iframe",
        "object",
        "embed",
        "head",
    }
    void_tags = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
    block_tags = {
        "article",
        "aside",
        "blockquote",
        "br",
        "dd",
        "div",
        "dl",
        "dt",
        "figcaption",
        "figure",
        "footer",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "li",
        "main",
        "nav",
        "p",
        "section",
        "table",
        "td",
        "th",
        "tr",
        "ul",
        "ol",
    }

    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.skip_depth = 0
        self.parts: List[str] = []
        self.images: List[str] = []

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        attributes = {key.lower(): (value or "") for key, value in attrs}
        hidden = (
            "hidden" in attributes
            or attributes.get("aria-hidden", "").lower() == "true"
            or "display:none" in attributes.get("style", "").replace(" ", "").lower()
            or "visibility:hidden" in attributes.get("style", "").replace(" ", "").lower()
        )
        if self.skip_depth or tag in self.ignored_tags or hidden:
            if tag not in self.void_tags:
                self.skip_depth += 1
            return
        if tag in self.block_tags:
            self.parts.append("\n")
        if tag == "img":
            src = attributes.get("src") or attributes.get("data-src") or ""
            alt = re.sub(r"\s+", " ", attributes.get("alt", "")).strip()
            if src:
                parsed = urlparse(urljoin(self.base_url, src))
                stable_url = parsed._replace(query="", fragment="").geturl()
                self.images.append(f"[画像] {alt} {stable_url}".strip())

    def handle_startendtag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        self.handle_starttag(tag, attrs)
        if self.skip_depth:
            self.skip_depth -= 1

    def handle_endtag(self, tag: str) -> None:
        if self.skip_depth:
            self.skip_depth -= 1
            return
        if tag in self.block_tags:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.skip_depth:
            self.parts.append(data)

    def normalized(self) -> str:
        raw = "".join(self.parts)
        lines = []
        for line in raw.splitlines():
            clean = re.sub(r"\s+", " ", line).strip()
            if clean:
                lines.append(clean)
        lines.extend(sorted(set(self.images)))
        return "\n".join(lines)


def normalize_html(html_text: str, base_url: str) -> str:
    parser = VisibleContentParser(base_url)
    parser.feed(html_text)
    parser.close()
    return parser.normalized()


def normalize_text(text: str) -> str:
    lines = []
    for line in text.splitlines():
        clean = re.sub(r"\s+", " ", line).strip()
        if clean:
            lines.append(clean)
    return "\n".join(lines)


def normalize_content(content: str, content_type: str, base_url: str) -> str:
    media_type = content_type.split(";", 1)[0].strip().lower()
    if media_type in {"text/html", "application/xhtml+xml"}:
        return normalize_html(content, base_url)
    if media_type == "application/json" or media_type.endswith("+json"):
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            return normalize_text(content)
        return json.dumps(parsed, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if media_type == "text/plain":
        return normalize_text(content)
    raise RuntimeError(f"対応していない形式です: {content_type or 'Content-Type不明'}")


def canonical_url(raw_url: str, base_url: str = "") -> str:
    """Make a stable page URL; fragments never identify different content."""
    parsed = urlparse(urljoin(base_url, raw_url))
    return parsed._replace(fragment="").geturl()


def is_page_url(url: str) -> bool:
    """Avoid adding downloads and static assets to a website monitor."""
    path = urlparse(url).path.lower()
    # WordPress and similar sites commonly expose /feed/ as a navigation link,
    # but it is RSS/XML rather than a viewable HTML page.
    if path.rstrip("/").endswith("/feed"):
        return False
    return not path.endswith((
        ".7z", ".avi", ".css", ".csv", ".doc", ".docx", ".gif", ".gz",
        ".ico", ".jpeg", ".jpg", ".js", ".mov", ".mp3", ".mp4", ".pdf",
        ".png", ".ppt", ".pptx", ".rss", ".svg", ".tar", ".tif", ".tiff",
        ".webp", ".xls", ".xlsx", ".xml", ".zip",
    ))


class InternalLinkParser(HTMLParser):
    """Collect navigable links without treating scripts or external domains as pages."""

    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.base = urlparse(base_url)
        self.links: List[str] = []

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        if tag != "a":
            return
        href = dict(attrs).get("href", "") or ""
        candidate = canonical_url(href, self.base_url)
        parsed = urlparse(candidate)
        if (
            parsed.scheme in {"http", "https"}
            and parsed.netloc == self.base.netloc
            and is_page_url(candidate)
            and candidate not in self.links
        ):
            self.links.append(candidate)


def extract_internal_links(html_text: str, base_url: str) -> List[str]:
    parser = InternalLinkParser(base_url)
    parser.feed(html_text)
    parser.close()
    return parser.links


def discover_internal_urls(root_url: str, max_depth: int = DISCOVERY_DEPTH) -> List[str]:
    """Find a small set of same-origin HTML pages for a newly added site.

    A link alone is not enough to become a monitor target: navigation often
    includes feeds, downloads, stale links, and other non-HTML resources.
    Candidates therefore have to be fetched successfully as HTML first.
    """
    max_depth = max(0, min(DISCOVERY_DEPTH, int(max_depth)))
    root = canonical_url(root_url)
    found: List[str] = [root]
    queue: List[Tuple[str, int]] = [(root, 0)]
    visited: Set[str] = set()
    while queue and len(found) < MAX_DISCOVERED_PAGES:
        current, depth = queue.pop(0)
        if current in visited:
            continue
        visited.add(current)
        try:
            html_text, headers = fetch_site({"url": current, "etag": "", "last_modified": ""})
        except Exception:
            continue
        if "html" not in headers.get("content_type", "").lower():
            continue
        if current != root:
            found.append(current)
            if len(found) >= MAX_DISCOVERED_PAGES:
                break
        if depth >= max_depth:
            continue
        for link in extract_internal_links(html_text, current):
            if link not in visited and not any(queued == link for queued, _ in queue):
                queue.append((link, depth + 1))
    return found


def site_urls(site: Any) -> List[str]:
    try:
        raw = json.loads(site["urls_json"] or "[]")
        urls = [canonical_url(str(value)) for value in raw if isinstance(value, str)]
    except (KeyError, TypeError, json.JSONDecodeError):
        urls = []
    root = canonical_url(site["url"])
    return list(dict.fromkeys([root, *urls]))


def discovered_urls(site: Any) -> List[str]:
    """Return saved discovery candidates, falling back to the monitored URLs."""
    try:
        raw = json.loads(site["discovered_urls_json"] or "[]")
        urls = [canonical_url(str(value)) for value in raw if isinstance(value, str)]
    except (KeyError, TypeError, json.JSONDecodeError):
        urls = []
    return list(dict.fromkeys([canonical_url(site["url"]), *(urls or site_urls(site))]))


def page_states(site: Any) -> Dict[str, Dict[str, Any]]:
    try:
        raw = json.loads(site["page_states_json"] or "{}")
        if isinstance(raw, dict):
            return {str(url): value for url, value in raw.items() if isinstance(value, dict)}
    except (KeyError, TypeError, json.JSONDecodeError):
        pass
    # Migration path for a pre-multi-page row: its stored snapshot belongs to
    # the root URL and remains a valid comparison baseline.
    if site["content_hash"]:
        return {
            canonical_url(site["url"]): {
                "etag": site["etag"] or "",
                "last_modified": site["last_modified"] or "",
                "content_hash": site["content_hash"],
                "snapshot": site["snapshot"] or "",
            }
        }
    return {}


def check_history(site: Any) -> List[Dict[str, Any]]:
    try:
        raw = json.loads(site["check_history_json"] or "[]")
        if isinstance(raw, list):
            saved = [item for item in raw if isinstance(item, dict)][:MAX_CHECK_HISTORY]
            if saved:
                return saved
    except (KeyError, TypeError, json.JSONDecodeError):
        pass
    # The releases before check history only stored the most recent time.
    # Preserve that real check as the first history item during migration.
    if site["last_checked"]:
        return [{
            "checked_at": site["last_checked"],
            "status": site["status"],
            "page_count": len(site_urls(site)),
        }]
    return []


def decode_page(raw: bytes, content_type: str) -> str:
    match = re.search(r"charset=([\w-]+)", content_type, flags=re.IGNORECASE)
    candidates = [match.group(1)] if match else []
    candidates.extend(["utf-8", "shift_jis", "euc_jp"])
    for encoding in candidates:
        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")


def fetch_site(site: Any) -> Tuple[str, Dict[str, str]]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
    }
    if site["etag"]:
        headers["If-None-Match"] = site["etag"]
    if site["last_modified"]:
        headers["If-Modified-Since"] = site["last_modified"]
    request = Request(site["url"], headers=headers)
    try:
        with urlopen(request, timeout=30) as response:
            content_type = response.headers.get("Content-Type", "")
            media_type = content_type.split(";", 1)[0].strip().lower()
            supported = (
                media_type in {"text/html", "application/xhtml+xml", "application/json", "text/plain"}
                or media_type.endswith("+json")
            )
            if not supported:
                raise RuntimeError(f"対応していない形式です: {content_type or 'Content-Type不明'}")
            raw = response.read(MAX_PAGE_BYTES + 1)
            if len(raw) > MAX_PAGE_BYTES:
                raise RuntimeError("ページサイズが10MBを超えています")
            return decode_page(raw, content_type), {
                "etag": response.headers.get("ETag", ""),
                "last_modified": response.headers.get("Last-Modified", ""),
                "content_type": content_type,
            }
    except HTTPError as exc:
        if exc.code == HTTPStatus.NOT_MODIFIED:
            return "", {"not_modified": "1"}
        raise RuntimeError(http_error_message(exc.code)) from exc
    except URLError as exc:
        raise RuntimeError(f"接続できませんでした: {exc.reason}") from exc


def http_error_message(code: int) -> str:
    """Explain, in plain Japanese, why a fetch failed so the user knows what to do."""
    if code in (401, 403):
        return (
            f"HTTP {code}: このサイトはボット対策で自動アクセスを拒否しています。"
            "ブラウザ以外からの取得を許可していないため、PageWatchではモニターできません"
            "（相手サイトの仕様で、設定を変えても回避できません）。"
        )
    if code == 404:
        return f"HTTP {code}: ページが見つかりません。URLが正しいか確認してください。"
    if code == 429:
        return f"HTTP {code}: アクセス回数が多すぎて一時的に制限されています。確認間隔を長くしてください。"
    if 500 <= code < 600:
        return f"HTTP {code}: 相手サイト側で一時的な不具合が起きています。しばらく待って再確認してください。"
    return f"HTTP {code}: ページを取得できませんでした。"


def _net_changes(old_lines: List[str], new_lines: List[str]) -> Tuple[List[str], List[str]]:
    """Return lines genuinely added / removed, ignoring pure reordering.

    A line that merely moved position appears the same number of times in both
    snapshots, so comparing per-line counts filters out that noise. Document
    order is preserved for readability.
    """
    old_counts = Counter(old_lines)
    new_counts = Counter(new_lines)

    added: List[str] = []
    seen: Counter = Counter()
    for line in new_lines:
        seen[line] += 1
        if seen[line] > old_counts.get(line, 0):
            added.append(line)

    removed: List[str] = []
    seen = Counter()
    for line in old_lines:
        seen[line] += 1
        if seen[line] > new_counts.get(line, 0):
            removed.append(line)
    return added, removed


def _format_change_group(label: str, items: List[str], limit: int = 6) -> str:
    shown = items[:limit]
    bullets = "\n".join(f"  ・{item[:180]}" for item in shown)
    if len(items) > limit:
        bullets += f"\n  …ほか{len(items) - limit}件"
    return f"{label}（{len(items)}件）:\n{bullets}"


def content_change(old: str, new: str) -> Tuple[List[str], List[str]]:
    """Net added / removed visible lines between two snapshots (ignores reordering)."""
    old_lines = [line.strip() for line in old.splitlines() if line.strip()]
    new_lines = [line.strip() for line in new.splitlines() if line.strip()]
    return _net_changes(old_lines, new_lines)


def summarize_changes(added: List[str], removed: List[str]) -> str:
    if not added and not removed:
        # Same visible text, different hash -> only the order changed.
        return "表示テキストの内容は同じですが、並び順が変わりました（新しい文章・画像の増減はありません）。"

    pieces: List[str] = []
    if added:
        pieces.append(_format_change_group("追加された内容", added))
    if removed:
        pieces.append(_format_change_group("なくなった内容", removed))
    return "\n".join(pieces)


def diff_summary(old: str, new: str) -> str:
    return summarize_changes(*content_change(old, new))


def add_event(db: sqlite3.Connection, site_id: int, kind: str, summary: str) -> None:
    db.execute(
        "INSERT INTO events (site_id, kind, summary, created_at) VALUES (?, ?, ?, ?)",
        (site_id, kind, summary, now_iso()),
    )


def send_desktop_notification(title: str, message: str) -> None:
    if sys.platform != "darwin":
        return
    script = (
        "on run argv\n"
        "display notification (item 2 of argv) with title (item 1 of argv)\n"
        "end run"
    )
    subprocess.run(
        ["osascript", "-e", script, title, message[:240]],
        check=False,
        capture_output=True,
        text=True,
    )


def send_email(settings: Dict[str, Any], subject: str, body: str) -> None:
    host = str(settings.get("smtp_host", "")).strip()
    recipient = str(settings.get("email_to", "")).strip()
    username = str(settings.get("smtp_user", "")).strip()
    sender = str(settings.get("smtp_from", "")).strip() or username
    password = str(settings.get("smtp_password", ""))
    if not host or not recipient or not sender:
        raise RuntimeError("メール設定が不足しています")

    mail = EmailMessage()
    mail["Subject"] = subject
    mail["From"] = sender
    mail["To"] = recipient
    mail.set_content(body)
    port = int(settings.get("smtp_port", 587))
    use_ssl = bool(settings.get("smtp_ssl", False))
    context = ssl.create_default_context()
    if use_ssl:
        server: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=30, context=context)
    else:
        server = smtplib.SMTP(host, port, timeout=30)
    try:
        if not use_ssl:
            server.starttls(context=context)
        if username:
            server.login(username, password)
        server.send_message(mail)
    finally:
        server.quit()


def notify_change(site: sqlite3.Row, summary: str) -> None:
    settings = load_settings()
    subject = f"[PageWatch] {site['name']} が更新されました"
    body = f"{site['name']}\n{site['url']}\n\n{summary}\n"
    if settings.get("desktop_notifications", True):
        send_desktop_notification(subject, summary)
    if settings.get("email_enabled", False):
        send_email(settings, subject, body)


def check_site(site_id: int) -> Dict[str, Any]:
    if not CHECK_LOCK.acquire(blocking=False):
        raise RuntimeError("別の確認処理が実行中です")
    try:
        with db_connect() as db:
            site = db.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
            if site is None:
                raise KeyError("モニターサイトが見つかりません")
            db.execute("UPDATE sites SET status = 'checking', last_error = NULL WHERE id = ?", (site_id,))

        try:
            checked_at = now_iso()
            states = page_states(site)
            urls = site_urls(site)
            # A database created by an older PageWatch release has no URL list.
            # Preserve its original single-page scope; only newly added sites
            # are expanded automatically by initialize_new_site().
            if site["urls_json"] is None:
                urls = [canonical_url(site["url"])]
                with db_connect() as db:
                    db.execute("UPDATE sites SET urls_json = ? WHERE id = ?", (json.dumps(urls), site_id))
            outcomes: List[str] = []
            changed_pages: List[Tuple[str, str]] = []
            errors: List[str] = []
            for page_url in urls:
                previous = states.get(page_url, {})
                try:
                    html_text, headers = fetch_site({
                        "url": page_url,
                        "etag": previous.get("etag", ""),
                        "last_modified": previous.get("last_modified", ""),
                    })
                    if headers.get("not_modified"):
                        outcomes.append("unchanged")
                        continue
                    snapshot = normalize_content(html_text, headers.get("content_type", "text/html"), page_url)
                    if not snapshot:
                        raise RuntimeError("比較できる表示内容が見つかりません")
                    content_hash = hashlib.sha256(snapshot.encode("utf-8")).hexdigest()
                    next_state = {
                        "etag": headers.get("etag", ""),
                        "last_modified": headers.get("last_modified", ""),
                        "content_hash": content_hash,
                        "snapshot": snapshot,
                    }
                    if not previous.get("content_hash"):
                        states[page_url] = next_state
                        outcomes.append("baseline")
                    elif previous.get("content_hash") == content_hash:
                        states[page_url] = next_state
                        outcomes.append("unchanged")
                    else:
                        added, removed = content_change(previous.get("snapshot", ""), snapshot)
                        states[page_url] = next_state
                        if not added and not removed:
                            outcomes.append("unchanged")
                        else:
                            changed_pages.append((page_url, summarize_changes(added, removed)))
                            outcomes.append("changed")
                except Exception as exc:
                    errors.append(f"{page_url}: {str(exc)[:300]}")
                    outcomes.append("error")

            if changed_pages:
                status = "changed"
                summary = "\n\n".join(f"[{url}]\n{change}" for url, change in changed_pages)
            elif errors:
                status = "error"
                summary = errors[0]
            elif "baseline" in outcomes:
                status = "baseline"
                summary = f"{len(outcomes)}ページの初回の比較基準を保存しました"
            else:
                status = "unchanged"
                summary = ""

            history = check_history(site)
            history.insert(0, {
                "checked_at": checked_at,
                "status": status,
                "page_count": len(urls),
            })
            history = history[:MAX_CHECK_HISTORY]
            with db_connect() as db:
                db.execute(
                    """
                    UPDATE sites SET status = ?, last_checked = ?,
                        last_changed = CASE WHEN ? = 'changed' THEN ? ELSE last_changed END,
                        last_error = ?, page_states_json = ?, check_history_json = ?
                    WHERE id = ?
                    """,
                    (
                        status, checked_at, status, checked_at,
                        errors[0] if errors else None,
                        json.dumps(states, ensure_ascii=False),
                        json.dumps(history, ensure_ascii=False),
                        site_id,
                    ),
                )
                if status in {"changed", "baseline", "error"}:
                    add_event(db, site_id, status, summary)

            if status == "changed":
                try:
                    notify_change(site, summary)
                except Exception as exc:  # Notification failure must not undo monitoring state.
                    logging.exception("Notification failed")
                    with db_connect() as db:
                        add_event(db, site_id, "notification_error", f"通知に失敗しました: {exc}")
            return {"changed": status == "changed", "status": status, "summary": summary}
        except Exception as exc:
            logging.exception("Check failed for site %s", site_id)
            with db_connect() as db:
                failed_at = now_iso()
                history = check_history(site)
                history.insert(0, {
                    "checked_at": failed_at,
                    "status": "error",
                    "page_count": len(site_urls(site)),
                })
                db.execute(
                    """
                    UPDATE sites SET status = 'error', last_checked = ?, last_error = ?,
                        check_history_json = ? WHERE id = ?
                    """,
                    (failed_at, str(exc)[:500], json.dumps(history[:MAX_CHECK_HISTORY]), site_id),
                )
                add_event(db, site_id, "error", f"確認に失敗しました: {str(exc)[:500]}")
            raise RuntimeError(str(exc)) from exc
    finally:
        CHECK_LOCK.release()


def check_all_enabled() -> None:
    with db_connect() as db:
        ids = [row[0] for row in db.execute("SELECT id FROM sites WHERE enabled = 1 ORDER BY id")]
    for site_id in ids:
        if STOP_EVENT.is_set():
            return
        try:
            check_site(site_id)
        except RuntimeError:
            continue


def discover_and_check(site_id: int) -> None:
    """Populate a newly added site's internal pages, then establish baselines."""
    with db_connect() as db:
        site = db.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
    if site is None:
        return
    discovered = discover_internal_urls(site["url"], site["discovery_depth"])
    with db_connect() as db:
        db.execute(
            "UPDATE sites SET urls_json = ?, discovered_urls_json = ? WHERE id = ?",
            (json.dumps(discovered), json.dumps(discovered), site_id),
        )
    check_site(site_id)


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def run_scheduler_cycle(now: Optional[datetime] = None) -> List[int]:
    """Run every site whose interval has elapsed and return the checked IDs.

    Keeping one cycle separate from the thread loop makes the cadence testable
    and prevents an unexpected database error from permanently killing the
    background scheduler.
    """
    current = now or datetime.now(timezone.utc)
    with db_connect() as db:
        sites = db.execute(
            "SELECT id, interval_minutes, last_checked FROM sites WHERE enabled = 1 ORDER BY id"
        ).fetchall()
    checked: List[int] = []
    for site in sites:
        last_checked = parse_iso(site["last_checked"])
        due = last_checked is None or (
            current - last_checked
        ).total_seconds() >= site["interval_minutes"] * 60
        if not due:
            continue
        try:
            check_site(site["id"])
            checked.append(site["id"])
            logging.info("Scheduled check completed for site %s", site["id"])
        except RuntimeError as exc:
            # A manual check can briefly hold the shared lock. The next cycle
            # retries the still-due site instead of losing its schedule.
            logging.warning("Scheduled check deferred for site %s: %s", site["id"], exc)
        except Exception:
            logging.exception("Scheduled check failed for site %s", site["id"])
    return checked


def scheduler_loop() -> None:
    if STOP_EVENT.wait(2):
        return
    while not STOP_EVENT.is_set():
        try:
            run_scheduler_cycle()
        except Exception:
            # Never let one transient SQLite/read failure stop every future
            # scheduled check.
            logging.exception("Scheduler cycle failed")
        STOP_EVENT.wait(SCHEDULER_POLL_SECONDS)


def site_rows() -> List[Dict[str, Any]]:
    with db_connect() as db:
        rows = db.execute(
            """
            SELECT id, name, url, interval_minutes, enabled, status, last_checked,
                   last_changed, last_error, etag, last_modified, content_hash, snapshot,
                   urls_json, discovered_urls_json, discovery_depth, page_states_json,
                   check_history_json, created_at
            FROM sites ORDER BY enabled DESC, created_at DESC
            """
        ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        urls = site_urls(row)
        item["urls"] = urls
        item["discovered_urls"] = discovered_urls(row)
        item["page_count"] = len(urls)
        item["checks"] = check_history(row)
        result.append(item)
    return result


def event_rows(limit: int = 50) -> List[Dict[str, Any]]:
    limit = max(1, min(200, limit))
    with db_connect() as db:
        rows = db.execute(
            """
            SELECT events.id, events.site_id, events.kind, events.summary, events.created_at,
                   sites.name AS site_name, sites.url AS site_url
            FROM events JOIN sites ON sites.id = events.site_id
            ORDER BY events.created_at DESC, events.id DESC LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def update_rows() -> List[Dict[str, Any]]:
    """Return every detected content change, including its readable diff.

    Check and error activity is intentionally kept separate from this history:
    an update must never disappear merely because later checks had no change.
    """
    with db_connect() as db:
        rows = db.execute(
            """
            SELECT events.id, events.site_id, events.kind, events.summary, events.created_at,
                   sites.name AS site_name, sites.url AS site_url
            FROM events JOIN sites ON sites.id = events.site_id
            WHERE events.kind = 'changed'
            ORDER BY events.created_at DESC, events.id DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def app_state() -> Dict[str, Any]:
    sites = site_rows()
    summary = {
        "total": len(sites),
        "active": sum(1 for site in sites if site["enabled"]),
        "changed": sum(1 for site in sites if site["status"] == "changed"),
        "errors": sum(1 for site in sites if site["status"] == "error"),
    }
    return {
        "version": APP_VERSION,
        "summary": summary,
        "sites": sites,
        "events": event_rows(),
        "updates": update_rows(),
        "settings": public_settings(),
    }


class PageWatchHandler(BaseHTTPRequestHandler):
    server_version = f"PageWatch/{APP_VERSION}"

    def log_message(self, format_string: str, *args: Any) -> None:
        logging.info("%s - %s", self.address_string(), format_string % args)

    def cors_origin(self) -> Optional[str]:
        # Origins allowed to call this local API from a browser page.
        # The GitHub Pages UI controls the local server through fetch(), which
        # requires CORS (and Chrome's Private Network Access preflight).
        allowed = getattr(self.server, "allowed_origins", DEFAULT_ALLOWED_ORIGINS)
        origin = self.headers.get("Origin", "")
        return origin if origin in allowed else None

    def end_headers(self) -> None:
        origin = self.cors_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        super().end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802
        origin = self.cors_origin()
        self.send_response(HTTPStatus.NO_CONTENT if origin else HTTPStatus.FORBIDDEN)
        if origin:
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            # Chrome Private Network Access: a public https page reaching
            # into 127.0.0.1 must be explicitly allowed.
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def send_json(self, data: Any, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Content-Lengthが不正です") from exc
        if length > 1024 * 1024:
            raise ValueError("リクエストが大きすぎます")
        if length == 0:
            return {}
        data = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("JSONオブジェクトが必要です")
        return data

    def route_site_id(self) -> Optional[int]:
        match = re.fullmatch(r"/api/sites/(\d+)(?:/check)?", urlparse(self.path).path)
        return int(match.group(1)) if match else None

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/health":
            self.send_json({"ok": True, "version": APP_VERSION, "time": now_iso()})
            return
        if path == "/api/state":
            self.send_json(app_state())
            return
        if path == "/api/events":
            self.send_json({"events": event_rows()})
            return
        self.serve_static(path)

    def do_POST(self) -> None:  # noqa: N802
        try:
            path = urlparse(self.path).path
            data = self.read_json()
            if path == "/api/sites":
                url = str(data.get("url", "")).strip()
                parsed = urlparse(url)
                if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                    raise ValueError("http:// または https:// から始まるURLを入力してください")
                name = str(data.get("name", "")).strip() or parsed.netloc
                interval = max(5, min(1440, int(data.get("interval_minutes", 15))))
                discovery_depth = max(0, min(DISCOVERY_DEPTH, int(data.get("discovery_depth", 0))))
                try:
                    with db_connect() as db:
                        cursor = db.execute(
                            """
                            INSERT INTO sites (name, url, interval_minutes, discovery_depth, enabled, status, created_at)
                            VALUES (?, ?, ?, ?, 1, 'waiting', ?)
                            """,
                            (name[:120], canonical_url(url), interval, discovery_depth, now_iso()),
                        )
                        site_id = cursor.lastrowid
                except sqlite3.IntegrityError as exc:
                    raise ValueError("このURLはすでに登録されています") from exc
                threading.Thread(target=self.safe_discover_and_check, args=(site_id,), daemon=True).start()
                self.send_json({"ok": True, "id": site_id}, 201)
                return
            page_match = re.fullmatch(r"/api/sites/(\d+)/pages", path)
            if page_match:
                site_id = int(page_match.group(1))
                raw_urls = data.get("urls", data.get("url", ""))
                candidates = raw_urls if isinstance(raw_urls, list) else [raw_urls]
                urls: List[str] = []
                for raw_url in candidates:
                    parsed = urlparse(str(raw_url).strip())
                    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                        raise ValueError("http:// または https:// から始まるURLを入力してください")
                    urls.append(canonical_url(str(raw_url).strip()))
                with db_connect() as db:
                    site = db.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
                    if site is None:
                        raise KeyError("モニターサイトが見つかりません")
                    merged = list(dict.fromkeys([*site_urls(site), *urls]))
                    candidates = list(dict.fromkeys([*discovered_urls(site), *urls]))
                    db.execute(
                        "UPDATE sites SET urls_json = ?, discovered_urls_json = ? WHERE id = ?",
                        (json.dumps(merged), json.dumps(candidates), site_id),
                    )
                threading.Thread(target=self.safe_check, args=(site_id,), daemon=True).start()
                self.send_json({"ok": True, "count": len(merged)})
                return
            if path == "/api/check-all":
                threading.Thread(target=check_all_enabled, daemon=True).start()
                self.send_json({"ok": True}, 202)
                return
            if path == "/api/settings/test-email":
                settings = load_settings()
                send_email(
                    settings,
                    "[PageWatch] テストメール",
                    "PageWatchからのテストメールです。メール通知は正常に設定されています。\n",
                )
                self.send_json({"ok": True})
                return
            if path.endswith("/check"):
                site_id = self.route_site_id()
                if site_id is None:
                    raise KeyError("モニターサイトが見つかりません")
                result = check_site(site_id)
                self.send_json({"ok": True, **result})
                return
            self.send_json({"error": "Not found"}, 404)
        except KeyError as exc:
            self.send_json({"error": str(exc)}, 404)
        except (ValueError, RuntimeError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, 400)
        except Exception as exc:
            logging.exception("POST failed")
            self.send_json({"error": str(exc)}, 500)

    def safe_check(self, site_id: int) -> None:
        time.sleep(0.2)
        try:
            check_site(site_id)
        except RuntimeError:
            pass

    def safe_discover_and_check(self, site_id: int) -> None:
        time.sleep(0.2)
        try:
            discover_and_check(site_id)
        except RuntimeError:
            pass

    def do_PATCH(self) -> None:  # noqa: N802
        try:
            site_id = self.route_site_id()
            if site_id is None:
                raise KeyError("モニターサイトが見つかりません")
            data = self.read_json()
            updates = []
            values: List[Any] = []
            if "enabled" in data:
                updates.append("enabled = ?")
                values.append(1 if data["enabled"] else 0)
                updates.append("status = CASE WHEN ? = 1 THEN 'waiting' ELSE 'paused' END")
                values.append(1 if data["enabled"] else 0)
            if "name" in data:
                updates.append("name = ?")
                values.append(str(data["name"]).strip()[:120])
            if "interval_minutes" in data:
                updates.append("interval_minutes = ?")
                values.append(max(5, min(1440, int(data["interval_minutes"]))))
            if not updates:
                raise ValueError("変更項目がありません")
            values.append(site_id)
            with db_connect() as db:
                cursor = db.execute(f"UPDATE sites SET {', '.join(updates)} WHERE id = ?", values)
                if cursor.rowcount == 0:
                    raise KeyError("モニターサイトが見つかりません")
            self.send_json({"ok": True})
        except KeyError as exc:
            self.send_json({"error": str(exc)}, 404)
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, 400)

    def do_PUT(self) -> None:  # noqa: N802
        try:
            path = urlparse(self.path).path
            page_match = re.fullmatch(r"/api/sites/(\d+)/pages", path)
            if page_match:
                data = self.read_json()
                raw_urls = data.get("urls", [])
                if not isinstance(raw_urls, list):
                    raise ValueError("URLの一覧が必要です")
                urls = []
                for raw_url in raw_urls:
                    parsed = urlparse(str(raw_url).strip())
                    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                        raise ValueError("http:// または https:// から始まるURLを入力してください")
                    urls.append(canonical_url(str(raw_url).strip()))
                site_id = int(page_match.group(1))
                with db_connect() as db:
                    site = db.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
                    if site is None:
                        raise KeyError("モニターサイトが見つかりません")
                    selected = list(dict.fromkeys([canonical_url(site["url"]), *urls]))
                    candidates = discovered_urls(site)
                    db.execute(
                        "UPDATE sites SET urls_json = ?, discovered_urls_json = ? WHERE id = ?",
                        (json.dumps(selected), json.dumps(candidates), site_id),
                    )
                threading.Thread(target=self.safe_check, args=(site_id,), daemon=True).start()
                self.send_json({"ok": True, "count": len(selected)})
                return
            if path != "/api/settings":
                self.send_json({"error": "Not found"}, 404)
                return
            settings = save_settings(self.read_json())
            self.send_json({"ok": True, "settings": settings})
        except (ValueError, json.JSONDecodeError, OSError) as exc:
            self.send_json({"error": str(exc)}, 400)

    def do_DELETE(self) -> None:  # noqa: N802
        site_id = self.route_site_id()
        if site_id is None:
            self.send_json({"error": "Not found"}, 404)
            return
        with db_connect() as db:
            cursor = db.execute("DELETE FROM sites WHERE id = ?", (site_id,))
        if cursor.rowcount == 0:
            self.send_json({"error": "モニターサイトが見つかりません"}, 404)
            return
        self.send_json({"ok": True})

    def serve_static(self, request_path: str) -> None:
        if not DIST_DIR.exists():
            self.send_json({"error": "画面が未ビルドです。npm run build を実行してください。"}, 503)
            return
        relative = unquote(request_path).lstrip("/") or "index.html"
        target = (DIST_DIR / relative).resolve()
        dist_root = DIST_DIR.resolve()
        if not str(target).startswith(str(dist_root)) or not target.is_file():
            target = dist_root / "index.html"
        try:
            body = target.read_bytes()
        except OSError:
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def configure_logging() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(LOG_PATH, encoding="utf-8"), logging.StreamHandler()],
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="PageWatch local website monitor")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--open", action="store_true", help="起動後にブラウザを開く")
    parser.add_argument("--open-url", help="--openで開く管理画面URL")
    parser.add_argument(
        "--allow-origin",
        action="append",
        dest="allowed_origins",
        help="ローカルAPIへの接続を許可するHTTPS origin（複数指定可）",
    )
    args = parser.parse_args()

    configure_logging()
    init_database()
    scheduler = threading.Thread(target=scheduler_loop, name="pagewatch-scheduler", daemon=True)
    scheduler.start()

    server = ThreadingHTTPServer((args.host, args.port), PageWatchHandler)
    server.allowed_origins = set(args.allowed_origins or DEFAULT_ALLOWED_ORIGINS)  # type: ignore[attr-defined]
    url = f"http://{args.host}:{args.port}"
    logging.info("PageWatch v%s started at %s", APP_VERSION, url)
    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(args.open_url or url)).start()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        STOP_EVENT.set()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
