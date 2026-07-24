// Backend abstraction: the same UI drives either the local Python server
// (data stays on this Mac) or the cloud (GitHub Actions checks sites while
// the Mac is closed; data lives in the private repo pagewatch-data).

export type Site = {
  id: number;
  name: string;
  url: string;
  interval_minutes: number;
  enabled: number;
  status: string;
  last_checked: string | null;
  last_changed: string | null;
  last_error: string | null;
  urls: string[];
  discovered_urls: string[];
  page_count: number;
  checks: CheckRun[];
};

export type CheckRun = {
  checked_at: string;
  status: string;
  page_count: number;
};

export type EventItem = {
  id: number;
  site_id: number;
  site_name: string;
  kind: string;
  summary: string;
  created_at: string;
};

export type Settings = {
  desktop_notifications: boolean;
  email_enabled: boolean;
  email_to: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password: string;
  smtp_password_set: boolean;
  smtp_from: string;
  smtp_ssl: boolean;
};

export type AppState = {
  version?: string;
  summary: { total: number; active: number; changed: number; errors: number };
  sites: Site[];
  events: EventItem[];
  updates: EventItem[];
  settings: Settings | null;
};

export type SourceKind = "local" | "cloud";

export interface Backend {
  kind: SourceKind;
  minInterval: number;
  intervalChoices: { value: number; label: string }[];
  loadState(): Promise<AppState>;
  addSite(input: { name: string; url: string; interval_minutes: number; discovery_depth: number }): Promise<void>;
  addPage(site: Site, url: string): Promise<void>;
  setPages(site: Site, urls: string[]): Promise<void>;
  checkSite(site: Site): Promise<string>;
  checkAll(): Promise<string>;
  toggleSite(site: Site): Promise<void>;
  deleteSite(site: Site): Promise<void>;
  setInterval(site: Site, minutes: number): Promise<void>;
  renameSite(site: Site, name: string): Promise<void>;
}

// ---------------------------------------------------------------- local ----

// When the UI is served from GitHub Pages, the local server lives at
// 127.0.0.1; when served from the server itself, relative URLs work.
const LOCAL_BASE = window.location.hostname.endsWith("github.io")
  ? "http://127.0.0.1:8765"
  : "";
const LOCAL_SERVER_VERSION = "1.2.7";

async function localApi<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(LOCAL_BASE + path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
    });
  } catch {
    throw new Error(
      "このMacのPageWatchサーバーに接続できません。start.command を実行してください。",
    );
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "処理に失敗しました");
  return data as T;
}

export class LocalBackend implements Backend {
  kind: SourceKind = "local";
  minInterval = 5;
  intervalChoices = [
    { value: 5, label: "5分" },
    { value: 15, label: "15分" },
    { value: 30, label: "30分" },
    { value: 60, label: "1時間" },
    { value: 360, label: "6時間" },
  ];

  async loadState(): Promise<AppState> {
    const state = await localApi<AppState>("/api/state");
    if (state.version !== LOCAL_SERVER_VERSION) {
      throw new Error(
        `ローカルサーバーが古いバージョンです（起動中: ${state.version || "旧版"}、必要: ${LOCAL_SERVER_VERSION}）。start.command をもう一度実行してください。`,
      );
    }
    // The UI can be newer than a still-running local server after an update.
    // Treat absent newer fields as legacy data instead of crashing on expand.
    return {
      ...state,
      sites: state.sites.map((site) => {
        const urls = Array.isArray(site.urls) && site.urls.length ? site.urls : [site.url];
        return {
          ...site,
          urls,
          discovered_urls: Array.isArray(site.discovered_urls) && site.discovered_urls.length
            ? site.discovered_urls
            : urls,
          page_count: site.page_count || urls.length,
          checks: Array.isArray(site.checks)
            ? site.checks
            : site.last_checked
              ? [{ checked_at: site.last_checked, status: site.status || "unchanged", page_count: site.page_count || 1 }]
              : [],
        };
      }),
    };
  }

  async addSite(input: { name: string; url: string; interval_minutes: number; discovery_depth: number }): Promise<void> {
    await localApi("/api/sites", { method: "POST", body: JSON.stringify(input) });
  }

  async addPage(site: Site, url: string): Promise<void> {
    await localApi(`/api/sites/${site.id}/pages`, {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  }

  async setPages(site: Site, urls: string[]): Promise<void> {
    await localApi(`/api/sites/${site.id}/pages`, {
      method: "PUT",
      body: JSON.stringify({ urls }),
    });
  }

  async checkSite(site: Site): Promise<string> {
    const result = await localApi<{ changed: boolean }>(`/api/sites/${site.id}/check`, {
      method: "POST",
      body: "{}",
    });
    return result.changed ? `${site.name} の更新を検知しました。` : `${site.name} に変化はありません。`;
  }

  async checkAll(): Promise<string> {
    await localApi("/api/check-all", { method: "POST", body: "{}" });
    return "すべてのサイトを順番に確認しています。";
  }

  async toggleSite(site: Site): Promise<void> {
    await localApi(`/api/sites/${site.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !site.enabled }),
    });
  }

  async deleteSite(site: Site): Promise<void> {
    await localApi(`/api/sites/${site.id}`, { method: "DELETE" });
  }

  async setInterval(site: Site, minutes: number): Promise<void> {
    await localApi(`/api/sites/${site.id}`, {
      method: "PATCH",
      body: JSON.stringify({ interval_minutes: minutes }),
    });
  }

  async renameSite(site: Site, name: string): Promise<void> {
    await localApi(`/api/sites/${site.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  async loadSettings(): Promise<Settings> {
    const state = await localApi<{ settings: Settings }>("/api/state");
    return state.settings;
  }

  async saveSettings(settings: Settings): Promise<Settings> {
    const result = await localApi<{ settings: Settings }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
    return result.settings;
  }

  async testEmail(): Promise<void> {
    await localApi("/api/settings/test-email", { method: "POST", body: "{}" });
  }
}

// ---------------------------------------------------------------- cloud ----

const DATA_OWNER = "t-shiokawa1";
const DATA_REPO = "pagewatch-data";
const WORKFLOW_FILE = "check.yml";
const TOKEN_KEY = "pagewatch-cloud-token";

export function getCloudToken(): string {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setCloudToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token.trim());
  else localStorage.removeItem(TOKEN_KEY);
}

type CloudSiteRecord = {
  id: number;
  url: string;
  name: string;
  interval_minutes: number;
  enabled: boolean;
  urls?: string[];
  discovered_urls?: string[];
  discovery_depth?: number;
  auto_discover?: boolean;
};

type CloudStateEntry = {
  status?: string;
  last_checked?: string;
  last_changed?: string;
  last_error?: string | null;
  content_hash?: string;
  checks?: CheckRun[];
};

async function gh<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getCloudToken();
  if (!token) throw new Error("クラウド用トークンが未設定です。右上の歯車から設定してください。");
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options?.headers || {}),
    },
  });
  if (response.status === 401) {
    throw new Error("トークンが無効です。右上の歯車から設定し直してください。");
  }
  if (response.status === 404) {
    throw new Error("クラウドのデータリポジトリにアクセスできません（権限またはリポジトリ名を確認）。");
  }
  if (response.status === 409) {
    throw new Error("クラウド側の更新と競合しました。数秒待ってからやり直してください。");
  }
  if (!response.ok) {
    throw new Error(`GitHub APIエラー (${response.status})`);
  }
  if (response.status === 204 || options?.method === "PUT") return undefined as T;
  return (await response.json()) as T;
}

// The Contents API omits the base64 body for files above 1 MB. state.json
// contains page snapshots and can legitimately grow past that limit, so read
// it using GitHub's raw representation instead of the JSON file envelope.
async function ghRaw(path: string): Promise<string> {
  const token = getCloudToken();
  if (!token) throw new Error("クラウド用トークンが未設定です。右上の歯車から設定してください。");
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.raw+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status === 401) throw new Error("トークンが無効です。右上の歯車から設定し直してください。");
  if (response.status === 404) throw new Error("クラウドのモニター履歴が見つかりません。");
  if (!response.ok) throw new Error(`GitHub APIエラー (${response.status})`);
  return response.text();
}

function decodeContent(base64: string): string {
  const bytes = Uint8Array.from(atob(base64.replace(/\n/g, "")), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeContent(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

async function readSites(): Promise<{ sites: CloudSiteRecord[]; sha: string }> {
  const file = await gh<{ content: string; sha: string }>(
    `/repos/${DATA_OWNER}/${DATA_REPO}/contents/sites.json`,
  );
  return { sites: JSON.parse(decodeContent(file.content)), sha: file.sha };
}

async function readCloudState(): Promise<{ sites?: Record<string, CloudStateEntry>; events?: EventItem[]; updates?: EventItem[] }> {
  // Ask the Contents endpoint only for the blob SHA.  Its base64 body is
  // unavailable after 1 MB, while the Git Blob endpoint can return the same
  // object in raw form without the large-file Contents response limitation.
  const file = await gh<{ sha: string }>(`/repos/${DATA_OWNER}/${DATA_REPO}/contents/state.json`);
  return JSON.parse(await ghRaw(`/repos/${DATA_OWNER}/${DATA_REPO}/git/blobs/${file.sha}`));
}

async function writeSites(sites: CloudSiteRecord[], sha: string, message: string): Promise<void> {
  await gh(`/repos/${DATA_OWNER}/${DATA_REPO}/contents/sites.json`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: encodeContent(JSON.stringify(sites, null, 1) + "\n"),
      sha,
    }),
  });
}

async function updateSites(
  message: string,
  update: (sites: CloudSiteRecord[]) => CloudSiteRecord[],
): Promise<void> {
  // A discovery workflow may finish between reading sites.json and writing a
  // checkbox change. Re-read and retry instead of making the person repeat it.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { sites, sha } = await readSites();
    try {
      await writeSites(update(sites), sha, message);
      return;
    } catch (error) {
      const isConflict = error instanceof Error && error.message.includes("競合");
      if (!isConflict || attempt === 2) throw error;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
}

async function dispatchCheck(inputs: Record<string, string>): Promise<void> {
  await gh(`/repos/${DATA_OWNER}/${DATA_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs }),
  });
}

export class CloudBackend implements Backend {
  kind: SourceKind = "cloud";
  minInterval = 30;
  intervalChoices = [
    { value: 30, label: "30分" },
    { value: 60, label: "1時間" },
    { value: 180, label: "3時間" },
    { value: 360, label: "6時間" },
  ];

  async loadState(): Promise<AppState> {
    const { sites } = await readSites();
    let cloudState: { sites?: Record<string, CloudStateEntry>; events?: EventItem[]; updates?: EventItem[] } = {};
    try {
      cloudState = await readCloudState();
    } catch {
      // state.json not created yet: first check has not run.
    }
    const entries = cloudState.sites || {};
    const merged: Site[] = sites.map((site) => {
      const entry = entries[String(site.id)] || {};
      return {
        id: site.id,
        name: site.name,
        url: site.url,
        interval_minutes: site.interval_minutes,
        enabled: site.enabled ? 1 : 0,
        status: site.enabled ? entry.status || "waiting" : "paused",
        last_checked: entry.last_checked || null,
        last_changed: entry.last_changed || null,
        last_error: entry.last_error || null,
        urls: site.urls?.length ? site.urls : [site.url],
        discovered_urls: site.discovered_urls?.length ? site.discovered_urls : (site.urls?.length ? site.urls : [site.url]),
        page_count: site.urls?.length || 1,
        checks: entry.checks?.length
          ? entry.checks
          : entry.last_checked
            ? [{ checked_at: entry.last_checked, status: entry.status || "unchanged", page_count: site.urls?.length || 1 }]
            : [],
      };
    });
    return {
      summary: {
        total: merged.length,
        active: merged.filter((s) => s.enabled).length,
        changed: merged.filter((s) => s.status === "changed").length,
        errors: merged.filter((s) => s.status === "error").length,
      },
      sites: merged,
      events: (cloudState.events || []).slice(0, 50),
      // `updates` is an append-only archive. Fall back to older state files
      // until their next cloud check performs the migration.
      updates: cloudState.updates || (cloudState.events || []).filter((event) => event.kind === "changed"),
      settings: null,
    };
  }

  async addSite(input: { name: string; url: string; interval_minutes: number; discovery_depth: number }): Promise<void> {
    const parsed = new URL(input.url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("http:// または https:// から始まるURLを入力してください");
    }
    const record: CloudSiteRecord = {
      id: Date.now(),
      url: input.url,
      name: input.name.trim() || parsed.hostname,
      interval_minutes: Math.max(this.minInterval, input.interval_minutes),
      enabled: true,
      urls: [input.url],
      discovery_depth: input.discovery_depth,
      auto_discover: input.discovery_depth > 0,
    };
    await updateSites(`add: ${record.name}`, (sites) => {
      if (sites.some((site) => site.url === input.url)) {
        throw new Error("このURLはすでに登録されています");
      }
      return [...sites, record];
    });
    await dispatchCheck({ only: String(record.id) });
  }

  async addPage(site: Site, url: string): Promise<void> {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error("http:// または https:// から始まるURLを入力してください");
    }
    await updateSites(`add page: ${site.name}`, (sites) => sites.map((record) => record.id === site.id ? {
      ...record,
      urls: Array.from(new Set([...(record.urls?.length ? record.urls : [record.url]), url])),
      discovered_urls: Array.from(new Set([...(record.discovered_urls?.length ? record.discovered_urls : (record.urls?.length ? record.urls : [record.url])), url])),
    } : record));
    await dispatchCheck({ only: String(site.id) });
  }

  async setPages(site: Site, urls: string[]): Promise<void> {
    const selected = Array.from(new Set([site.url, ...urls]));
    const candidates = Array.from(new Set([site.url, ...site.discovered_urls]));
    await updateSites(`select pages: ${site.name}`, (sites) => sites.map((record) => record.id === site.id ? {
      ...record,
      urls: selected,
      discovered_urls: record.discovered_urls?.length ? record.discovered_urls : candidates,
    } : record));
    await dispatchCheck({ only: String(site.id) });
  }

  async checkSite(site: Site): Promise<string> {
    await dispatchCheck({ only: String(site.id) });
    return `${site.name} の確認をクラウドで開始しました。1〜2分後に反映されます。`;
  }

  async checkAll(): Promise<string> {
    await dispatchCheck({ all: "true" });
    return "全サイトの確認をクラウドで開始しました。1〜2分後に反映されます。";
  }

  async toggleSite(site: Site): Promise<void> {
    await updateSites(`${site.enabled ? "pause" : "resume"}: ${site.name}`, (sites) =>
      sites.map((record) => (record.id === site.id ? { ...record, enabled: !site.enabled } : record)),
    );
  }

  async deleteSite(site: Site): Promise<void> {
    await updateSites(`remove: ${site.name}`, (sites) => sites.filter((record) => record.id !== site.id));
  }

  async setInterval(site: Site, minutes: number): Promise<void> {
    await updateSites(`interval: ${site.name} -> ${minutes}min`, (sites) => sites.map((record) =>
      record.id === site.id ? { ...record, interval_minutes: Math.max(this.minInterval, minutes) } : record,
    ));
  }

  async renameSite(site: Site, name: string): Promise<void> {
    await updateSites(`rename: ${site.name} -> ${name}`, (sites) =>
      sites.map((record) => (record.id === site.id ? { ...record, name } : record)),
    );
  }
}
