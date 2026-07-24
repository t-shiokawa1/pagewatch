import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Backend,
  CheckRun,
  CloudBackend,
  EventItem,
  LocalBackend,
  Settings,
  Site,
  SourceKind,
  getCloudToken,
  setCloudToken,
} from "./backend";

const emptySettings: Settings = {
  desktop_notifications: true,
  email_enabled: false,
  email_to: "",
  smtp_host: "",
  smtp_port: 587,
  smtp_user: "",
  smtp_password: "",
  smtp_password_set: false,
  smtp_from: "",
  smtp_ssl: false,
};

const emptyState: AppState = {
  summary: { total: 0, active: 0, changed: 0, errors: 0 },
  sites: [],
  events: [],
  updates: [],
  settings: null,
};

const STATUS_TONE: Record<string, string> = {
  waiting: "neutral",
  checking: "working",
  baseline: "good",
  unchanged: "good",
  changed: "changed",
  seen: "good",
  error: "error",
  paused: "neutral",
};

const SOURCE_KEY = "pagewatch-source";
const ADMIN_KEY = "pagewatch-admin";
const LANG_KEY = "pagewatch-lang";
const DOWNLOAD_URL = "https://github.com/t-shiokawa1/Page-Watch/archive/refs/heads/main.zip";
const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
const APP_VERSION = "1.2.7";

type Lang = "ja" | "en";

// All user-facing copy lives here so the whole UI can switch between Japanese
// and English from one toggle, instead of showing both languages at once.
const T = {
  ja: {
    home: "PageWatch ホーム",
    srcAria: "モニターの実行場所",
    srcLocal: "このMac",
    srcCloud: "クラウド",
    langAria: "言語を切り替え",
    settings: "設定",
    close: "閉じる",
    addKicker: "新規追加",
    addTitle: "サイトを追加",
    fUrl: "サイトURL",
    fDiscovery: "探索する階層",
    discoveryNone: "探索しない（トップURLのみ）",
    discoveryOne: "1階層下まで",
    discoveryTwo: "2階層下まで",
    pages: (count: number) => `モニターページ ${count}件`,
    pageUrls: "モニターするURL",
    pageSelectHint: "選択を保存するまで、モニター対象は変わりません。",
    pageSelectionCount: (selected: number, total: number) => `モニター中 ${selected} / ${total} ページ`,
    rootPage: "トップURL（常にモニター）",
    selectAllPages: "すべて選択",
    clearChildPages: "子ページを解除",
    savePageSelection: "選択を保存",
    savingPageSelection: "保存中",
    pageUrl: "追加するURL",
    addPage: "URLを追加",
    fName: "表示名",
    optional: "任意",
    phName: "ニュース",
    fInterval: "確認間隔",
    addBtn: "モニターを始める",
    addBtnBusy: "追加中",
    statTotal: "登録",
    statActive: "モニター中",
    statChanged: "更新あり",
    statErrors: "エラー",
    watchKicker: "モニター中",
    watchTitle: "モニターリスト",
    checkAll: "すべて確認",
    expandAria: "詳細を開閉",
    detailHistory: "このサイトの更新履歴",
    loadingList: "読み込んでいます",
    emptyList: "最初のモニターサイトを上のフォームから追加してください。",
    lastChecked: "最終確認",
    nextCheck: "次回確認",
    checkWaiting: "確認待ち",
    firstCheckWaiting: "初回確認待ち",
    checkPlanned: (time: string) => `予定 ${time}`,
    checkLate: (time: string, delay: string) => `予定 ${time} · ${delay}遅れ`,
    pausedNextCheck: "一時停止中",
    checkHistory: "確認履歴",
    checkHistoryHint: "更新の有無に関係なく、直近20回の確認時刻を記録します。",
    checkHistoryEmpty: "まだ確認記録がありません。",
    checkPages: (count: number) => `${count}ページを確認`,
    checkResult: {
      baseline: "初回確認",
      unchanged: "変化なし",
      changed: "更新を検知",
      error: "エラー",
      checking: "確認中",
    } as Record<string, string>,
    checkLane: "確認",
    checksCount: (count: number) => `${count}回`,
    checkGraphHint: "縦線＝確認、橙＝更新を検知、赤＝エラー",
    checkNow: "今すぐ確認",
    pause: "一時停止",
    resume: "再開",
    del: "削除",
    renameHint: "クリックで表示名を変更",
    tRenamed: "表示名を変更しました。",
    chartKicker: "変化の記録",
    chartTitle: "変化の推移",
    chartUnit: "件",
    chartEmpty: "この期間に変化は検知されていません。",
    nowLabel: "現在",
    viewLanes: "レーン",
    viewCumulative: "累積",
    viewHours: "時間帯",
    viewAria: "グラフの種類",
    rangeAria: "表示期間",
    subLanes: "サイト別・変化を検知した時刻（●の大きさ＝変化量）",
    subCumulative: "累積の変化量（行数）",
    subHours: "時間帯ごとの変化量（濃さ＝行数）",
    hoursAxis: ["0時", "6時", "12時", "18時", "23時"],
    histKicker: "検出した更新",
    histTitle: "更新内容（すべて）",
    histHint: "更新を検出した履歴だけを、古いものを含めてすべて表示します。確認のみ・エラーは確認履歴で確認できます。",
    histEmpty: "まだ更新は検出されていません。",
    updatesCount: (count: number) => `全${count}件`,
    evChanged: "更新",
    evError: "エラー",
    evBaseline: "開始",
    evNotify: "通知",
    notChecked: "まだ確認していません",
    footerCloud: "モニターリストと履歴は、あなただけがアクセスできる非公開リポジトリに保存されます。",
    footerLocal: "あなたのモニターデータは、このMacから外へ保存されません。",
    footerSrcCloud: "クラウド",
    footerSrcLocal: "このMacのみ",
    top: "TOP ↑",
    status: {
      waiting: "確認待ち",
      checking: "確認中",
      baseline: "モニター中",
      unchanged: "変化なし",
      changed: "更新あり",
      seen: "既読",
      error: "要確認",
      paused: "一時停止",
    } as Record<string, string>,
    ackHint: "クリックで既読にする",
    ackAll: "すべて既読に",
    seenAt: (time: string) => `既読 ${time}`,
    sinceUpdates: (time: string, n: number) => `${time}以来 ${n}件更新`,
    tAddCloud: "クラウドのモニターリストに追加しました。初回チェックを開始します。",
    tAddLocal: "モニターサイトを追加しました。最初の比較基準を作成します。",
    confirmDelete: (name: string) => `「${name}」と更新履歴を削除しますか？`,
    tDeleted: "モニターサイトを削除しました。",
    tIntervalChanged: "確認間隔を変更しました。",
    tTokenSaved: "トークンを保存しました。",
    tTokenRemoved: "トークンを削除しました。",
    tSettingsSaved: "通知設定を保存しました。",
    tTestSent: "テストメールを送信しました。",
    tConnErr: "接続できません",
    tActionErr: "処理に失敗しました",
    tBadUrl: "http:// または https:// で始まるURLを入力してください。",
    tDupUrl: "このURLはすでに登録されています。",
    tPageAdded: "モニターURLを追加しました。比較基準を作成します。",
    tPageSelection: "モニターするURLを更新しました。",
    every: (label: string) => `${label}ごと`,
    // setup: local offline
    loKicker: "はじめに / このMacでモニター",
    loTitle: "このMacのモニタープログラムが起動していません",
    loLead:
      "「このMac」モードは、あなたのMac上で動く小さなプログラムがモニターします。まだ入っていない場合は、次の手順で始めてください（データはこのMacの外に出ません）。",
    loStep1: "下のボタンからアプリ一式（ZIP）をダウンロードします。",
    loStep2a: "ダウンロードした ",
    loStep2b: " をダブルクリックして展開します。",
    loStep3a: "できたフォルダの中の ",
    loStep3b: " をダブルクリックします。",
    loStep4head: "「\"start.command\" is not opened / 開けませんでした」と出た場合",
    loStep4note: "（初回のみ）：",
    loStep4a: "① 「ゴミ箱に入れる」は押さず「完了（Done）」を押す",
    loStep4b: "② Appleメニュー →「システム設定」→「プライバシーとセキュリティ」を開く",
    loStep4c: "③ 下の方の「このまま開く（Open Anyway）」を押し、Touch IDまたはパスワードで承認",
    loStep4d: "④ もう一度 start.command をダブルクリック →「開く」",
    loStep5: "この画面に戻り、下のボタンで再読み込みするとモニターリストが表示されます。",
    loStep5note: "macOS標準のPython3で動きます。起動に数十秒かかることがあります。",
    loDownload: "アプリをダウンロード（ZIP）",
    reload: "再読み込み",
    loAltSummary: "うまくいかないとき（ターミナルで解除）",
    loAltP1:
      "ターミナルを開き、次を入力して最後に半角スペースを打ち、展開したフォルダをウインドウにドラッグ＆ドロップしてEnter：",
    loAltDrag: "（ここにフォルダをドラッグ）",
    loAltP2a: "その後 ",
    loAltP2b: " をダブルクリックすれば開きます。",
    // setup: cloud token
    ctKicker: "はじめに / クラウドでモニター",
    ctTitle: "クラウドモニターを使うには、最初に1回だけ設定が必要です",
    ctLead:
      "「クラウド」モードは、Macを閉じていてもモニターを続けます。あなたのGitHubアカウントで、専用の合言葉（トークン）を1つ作って貼り付けてください。",
    ctStep1: "下のボタンでGitHubのトークン作成画面を開きます。",
    ctStep1note: "Repository access は pagewatch-data のみ、Permissions は Contents と Actions を「Read and write」に。",
    ctStep2: "作成された文字列（github_pat_…）をコピーします。",
    ctStep3: "「トークンを入力」ボタンから貼り付けて保存します。",
    ctStep3note: "このブラウザにだけ保存されます。",
    ctCreate: "トークンを作成（GitHub）",
    ctEnter: "トークンを入力",
    // cloud dialog
    cdKicker: "設定",
    cdTitle: "クラウド設定",
    cdTokenLabel: "GitHubアクセストークン",
    cdNote1:
      "このブラウザにのみ保存されます。GitHubの「Settings → Developer settings → Fine-grained tokens」で、リポジトリ pagewatch-data だけを対象に Contents（Read and write）と Actions（Read and write）を許可したトークンを作成してください。",
    cdNote2:
      "メール通知は pagewatch-data リポジトリの Settings → Secrets and variables → Actions に SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / EMAIL_TO を登録すると有効になります。",
    save: "保存",
    // notification dialog
    ndKicker: "通知",
    ndTitle: "通知設定",
    ndDesktop: "macOS通知",
    ndDesktopNote: "更新時に通知センターへ表示",
    ndEmail: "メール通知",
    ndEmailNote: "SMTPを使って指定先へ送信",
    ndTo: "通知先メールアドレス",
    ndHost: "SMTPホスト",
    ndPort: "ポート",
    ndUser: "ユーザー名",
    ndPassword: "パスワード",
    ndPasswordSaved: "（保存済み・空欄なら変更なし）",
    ndFrom: "送信元",
    ndFromNote: "空欄ならユーザー名",
    ndSsl: "SSL接続を使用（通常の587番ではオフ）",
    ndTest: "テスト送信",
    ndSave: "設定を保存",
  },
  en: {
    home: "PageWatch home",
    srcAria: "Where checks run",
    srcLocal: "This Mac",
    srcCloud: "Cloud",
    langAria: "Switch language",
    settings: "Settings",
    close: "Close",
    addKicker: "Add a watch",
    addTitle: "Add a site",
    fUrl: "Site URL",
    fDiscovery: "Link depth",
    discoveryNone: "Do not explore (top URL only)",
    discoveryOne: "One level below",
    discoveryTwo: "Two levels below",
    pages: (count: number) => `${count} monitored page${count === 1 ? "" : "s"}`,
    pageUrls: "Monitored URLs",
    pageSelectHint: "Only checked URLs are monitored. The top URL is always included.",
    pageSelectionCount: (selected: number, total: number) => `${selected} of ${total} pages monitored`,
    rootPage: "Top URL (always monitored)",
    selectAllPages: "Select all",
    clearChildPages: "Clear child pages",
    savePageSelection: "Save selection",
    savingPageSelection: "Saving",
    pageUrl: "URL to add",
    addPage: "Add URL",
    fName: "Display name",
    optional: "optional",
    phName: "News",
    fInterval: "Check interval",
    addBtn: "Start watching",
    addBtnBusy: "Adding",
    statTotal: "Sites",
    statActive: "Active",
    statChanged: "Changed",
    statErrors: "Errors",
    watchKicker: "Watching now",
    watchTitle: "Watch list",
    checkAll: "Check all",
    expandAria: "Toggle details",
    detailHistory: "This site's history",
    loadingList: "Loading",
    emptyList: "Add your first site from the form above.",
    lastChecked: "Last checked",
    nextCheck: "Next check",
    checkWaiting: "Waiting to check",
    firstCheckWaiting: "Waiting for first check",
    checkPlanned: (time: string) => `Planned ${time}`,
    checkLate: (time: string, delay: string) => `Planned ${time} · ${delay} overdue`,
    pausedNextCheck: "Paused",
    checkHistory: "Check history",
    checkHistoryHint: "Records the 20 most recent checks, whether or not the page changed.",
    checkHistoryEmpty: "No checks recorded yet.",
    checkPages: (count: number) => `${count} page${count === 1 ? "" : "s"} checked`,
    checkResult: {
      baseline: "First check",
      unchanged: "No change",
      changed: "Change found",
      error: "Error",
      checking: "Checking",
    } as Record<string, string>,
    checkLane: "Checks",
    checksCount: (count: number) => `${count} check${count === 1 ? "" : "s"}`,
    checkGraphHint: "tick = check, orange = change found, red = error",
    checkNow: "Check now",
    pause: "Pause",
    resume: "Resume",
    del: "Delete",
    renameHint: "Click to rename",
    tRenamed: "Display name updated.",
    chartKicker: "Change activity",
    chartTitle: "Changes over time",
    chartUnit: "changes",
    chartEmpty: "No changes detected in this range.",
    nowLabel: "now",
    viewLanes: "Lanes",
    viewCumulative: "Cumulative",
    viewHours: "By hour",
    viewAria: "Chart type",
    rangeAria: "Time range",
    subLanes: "Detection times by site (dot size = magnitude)",
    subCumulative: "Cumulative lines changed",
    subHours: "Change volume by hour (darker = more lines)",
    hoursAxis: ["0h", "6h", "12h", "18h", "23h"],
    histKicker: "Detected changes",
    histTitle: "All change details",
    histHint: "Shows every detected change, including older ones. Checks without a change and errors appear in Check history.",
    histEmpty: "No changes have been detected yet.",
    updatesCount: (count: number) => `${count} total`,
    evChanged: "Changed",
    evError: "Error",
    evBaseline: "Started",
    evNotify: "Notified",
    notChecked: "Not checked yet",
    footerCloud: "Your watch list and history are stored in a private repository only you can access.",
    footerLocal: "Your monitoring data is never stored outside this Mac.",
    footerSrcCloud: "CLOUD",
    footerSrcLocal: "LOCAL ONLY",
    top: "TOP ↑",
    status: {
      waiting: "Waiting",
      checking: "Checking",
      baseline: "Watching",
      unchanged: "No change",
      changed: "Changed",
      seen: "Seen",
      error: "Check needed",
      paused: "Paused",
    } as Record<string, string>,
    ackHint: "Click to mark as seen",
    ackAll: "Mark all seen",
    seenAt: (time: string) => `Seen ${time}`,
    sinceUpdates: (time: string, n: number) => `${n} update${n === 1 ? "" : "s"} since ${time}`,
    tAddCloud: "Added to the cloud watch list. Running the first check now.",
    tAddLocal: "Site added. Creating the first baseline for comparison.",
    confirmDelete: (name: string) => `Delete “${name}” and its update history?`,
    tDeleted: "Site removed.",
    tIntervalChanged: "Check interval updated.",
    tTokenSaved: "Token saved.",
    tTokenRemoved: "Token removed.",
    tSettingsSaved: "Notification settings saved.",
    tTestSent: "Test email sent.",
    tConnErr: "Can't connect.",
    tActionErr: "Something went wrong.",
    tBadUrl: "Enter a URL that starts with http:// or https://.",
    tDupUrl: "This URL is already registered.",
    tPageAdded: "Monitoring URL added. Creating its comparison baseline.",
    tPageSelection: "Monitored URLs updated.",
    every: (label: string) => `every ${label}`,
    // setup: local offline
    loKicker: "Get started / This Mac",
    loTitle: "The monitoring program on this Mac isn't running",
    loLead:
      "“This Mac” mode is powered by a small program running on your Mac. If it isn't set up yet, follow these steps (your data never leaves this Mac).",
    loStep1: "Download the app bundle (ZIP) with the button below.",
    loStep2a: "Double-click the downloaded ",
    loStep2b: " to unzip it.",
    loStep3a: "Double-click ",
    loStep3b: " inside the resulting folder.",
    loStep4head: "If you see “\"start.command\" is not opened”",
    loStep4note: " (first time only):",
    loStep4a: "① Click “Done” — do NOT click “Move to Trash”",
    loStep4b: "② Apple menu → System Settings → Privacy & Security",
    loStep4c: "③ Click “Open Anyway” near the bottom and approve with Touch ID or your password",
    loStep4d: "④ Double-click start.command again → “Open”",
    loStep5: "Come back to this screen and click Reload below to see your watch list.",
    loStep5note: "It runs on the Python 3 that ships with macOS. Startup can take a few tens of seconds.",
    loDownload: "Download the app (ZIP)",
    reload: "Reload",
    loAltSummary: "If it still won't open (unlock via Terminal)",
    loAltP1:
      "Open Terminal, type the following, add a trailing space, then drag the unzipped folder onto the window and press Enter:",
    loAltDrag: "(drag the folder here)",
    loAltP2a: "Then double-click ",
    loAltP2b: " to open it.",
    // setup: cloud token
    ctKicker: "Get started / Cloud",
    ctTitle: "Cloud monitoring needs a one-time setup",
    ctLead:
      "“Cloud” mode keeps watching even while your Mac is closed. Create one access token (a passphrase) on your GitHub account and paste it in.",
    ctStep1: "Open GitHub's token creation screen with the button below.",
    ctStep1note: "Repository access: pagewatch-data only. Permissions: set Contents and Actions to “Read and write”.",
    ctStep2: "Copy the generated string (github_pat_…).",
    ctStep3: "Paste and save it via the “Enter token” button.",
    ctStep3note: "It is stored only in this browser.",
    ctCreate: "Create a token (GitHub)",
    ctEnter: "Enter token",
    // cloud dialog
    cdKicker: "Settings",
    cdTitle: "Cloud settings",
    cdTokenLabel: "GitHub access token",
    cdNote1:
      "Stored only in this browser. In GitHub's Settings → Developer settings → Fine-grained tokens, create a token scoped to only the pagewatch-data repository, with Contents (Read and write) and Actions (Read and write).",
    cdNote2:
      "Email notifications turn on when you add SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / EMAIL_TO under the pagewatch-data repository's Settings → Secrets and variables → Actions.",
    save: "Save",
    // notification dialog
    ndKicker: "Notifications",
    ndTitle: "Notifications",
    ndDesktop: "macOS notifications",
    ndDesktopNote: "Show in Notification Center on changes",
    ndEmail: "Email notifications",
    ndEmailNote: "Send via SMTP to the address below",
    ndTo: "Notification email address",
    ndHost: "SMTP host",
    ndPort: "Port",
    ndUser: "Username",
    ndPassword: "Password",
    ndPasswordSaved: "(saved — leave blank to keep)",
    ndFrom: "From",
    ndFromNote: "defaults to username",
    ndSsl: "Use SSL (off for the usual port 587)",
    ndTest: "Send test",
    ndSave: "Save settings",
  },
};

type Dict = (typeof T)["ja"];

function detectLang(): Lang {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === "ja" || saved === "en") return saved;
  return navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en";
}

// Cloud mode writes to the owner's private data repo, so only the owner can use
// it. Regular visitors see only the local option. The owner unlocks the cloud
// toggle by opening the page once with ?admin (persisted per-browser); locking
// is via ?admin=off.
function detectAdmin(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.has("admin")) {
    const on = params.get("admin") !== "off";
    if (on) localStorage.setItem(ADMIN_KEY, "1");
    else localStorage.removeItem(ADMIN_KEY);
    params.delete("admin");
    const query = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : ""));
    return on;
  }
  return localStorage.getItem(ADMIN_KEY) === "1";
}

function defaultSource(isAdmin: boolean): SourceKind {
  if (!isAdmin) return "local";
  const saved = localStorage.getItem(SOURCE_KEY);
  if (saved === "local" || saved === "cloud") return saved;
  return window.location.hostname.endsWith("github.io") ? "cloud" : "local";
}

function formatDate(value: string | null, lang: Lang, t: Dict): string {
  if (!value) return t.notChecked;
  return new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-US", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatRelative(value: string | null, lang: Lang, t: Dict): string {
  if (!value) return t.notChecked;
  const deltaSeconds = (Date.parse(value) - Date.now()) / 1000;
  const abs = Math.abs(deltaSeconds);
  const formatter = new Intl.RelativeTimeFormat(lang === "ja" ? "ja-JP" : "en-US", { numeric: "auto" });
  if (abs < 60) return formatter.format(Math.round(deltaSeconds), "second");
  if (abs < 3600) return formatter.format(Math.round(deltaSeconds / 60), "minute");
  if (abs < 86400) return formatter.format(Math.round(deltaSeconds / 3600), "hour");
  return formatter.format(Math.round(deltaSeconds / 86400), "day");
}

function formatDuration(milliseconds: number, lang: Lang): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return lang === "ja" ? `${minutes}分` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!remainder) return lang === "ja" ? `${hours}時間` : `${hours}h`;
  return lang === "ja" ? `${hours}時間${remainder}分` : `${hours}h ${remainder}m`;
}

function nextCheckInfo(site: Site, lang: Lang, t: Dict): { primary: string; detail: string; overdue: boolean } {
  if (!site.enabled) return { primary: t.pausedNextCheck, detail: "", overdue: false };
  if (!site.last_checked) return { primary: t.firstCheckWaiting, detail: "", overdue: false };
  const next = Date.parse(site.last_checked) + site.interval_minutes * 60_000;
  const scheduledAt = formatDate(new Date(next).toISOString(), lang, t);
  if (next <= Date.now()) {
    return {
      primary: t.checkWaiting,
      detail: t.checkLate(scheduledAt, formatDuration(Date.now() - next, lang)),
      overdue: true,
    };
  }
  return {
    primary: formatRelative(new Date(next).toISOString(), lang, t),
    detail: t.checkPlanned(scheduledAt),
    overdue: false,
  };
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Human-readable interval, computed from minutes so it localizes without
// depending on the backend's (Japanese) choice labels.
function fmtInterval(minutes: number, lang: Lang): string {
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return lang === "ja" ? `${h}時間` : `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  return lang === "ja" ? `${minutes}分` : `${minutes} min`;
}

// Small line icons for the per-row controls. Clearer than the old glyph hacks
// ("Ⅱ" roman numeral for pause, "×" for delete) and they inherit currentColor.
function IconRefresh({ spin }: { spin?: boolean }) {
  return (
    <svg className={`icn${spin ? " spin" : ""}`} viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-.9 4.5" />
      <path d="M20 4v6h-6" />
    </svg>
  );
}
function IconPause() {
  return (
    <svg className="icn" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}
function IconPlay() {
  return (
    <svg className="icn" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M7 4.5l13 7.5-13 7.5z" />
    </svg>
  );
}
function IconTrash() {
  return (
    <svg className="icn" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7" />
      <path d="M6.3 7l.9 12a1.6 1.6 0 0 0 1.6 1.5h6.4a1.6 1.6 0 0 0 1.6-1.5l.9-12" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function StatusBadge({ status, t, onAck, title }: { status: string; t: Dict; onAck?: () => void; title?: string }) {
  const tone = STATUS_TONE[status] || "neutral";
  const label = t.status[status] || t.status.waiting;
  const inner = (
    <>
      {/* The "changed" state keeps its acid-green fill, but a sparkle (not just a
          calm dot) marks it as "something new" so the green doesn't read as "OK". */}
      {tone === "changed" ? (
        <svg className="status-icon" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
          <path fill="currentColor" d="M12 1.7l2.4 6.9 6.9 2.4-6.9 2.4L12 20.3l-2.4-6.9L2.7 11l6.9-2.4z" />
        </svg>
      ) : (
        <span className="status-dot" />
      )}
      {label}
    </>
  );
  // A "changed" badge doubles as the acknowledge button: one click marks the
  // update as seen (stored per-browser) until the site changes again.
  if (onAck) {
    return (
      <button type="button" className={`status-badge status-${tone} status-ack`} onClick={onAck} title={title ?? t.ackHint}>
        {inner}
      </button>
    );
  }
  return <span className={`status-badge status-${tone}`} title={title}>{inner}</span>;
}

// Where a site's favicon might live, most specific first. Project pages served
// from a subpath (e.g. github.io/Repo/) keep their icon under that path, not at
// the domain root, so try the URL's directory before falling back to the root.
function faviconCandidates(rawUrl: string): string[] {
  try {
    const u = new URL(rawUrl);
    const dir = u.pathname.replace(/[^/]*$/, ""); // strip the last path segment
    const names = ["favicon.ico", "favicon.svg", "apple-touch-icon.png", "favicon.png"];
    const bases: string[] = [];
    if (dir && dir !== "/") bases.push(`${u.origin}${dir}`);
    bases.push(`${u.origin}/`);
    return bases.flatMap((base) => names.map((n) => base + n));
  } catch {
    return [];
  }
}

function pageLabel(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return url.pathname === "/" ? url.hostname : url.pathname.replace(/\/$/, "") || url.hostname;
  } catch {
    return rawUrl;
  }
}

// The site's own favicon (never a third-party service, to match the app's
// "your data stays here" promise). Falls back to the name's first letter.
function SiteIcon({ site }: { site: Site }) {
  const candidates = useMemo(() => faviconCandidates(site.url), [site.url]);
  const [idx, setIdx] = useState(0);
  useEffect(() => setIdx(0), [site.url]);
  const letter = (site.name.trim() || hostname(site.url)).charAt(0).toUpperCase();
  if (idx >= candidates.length) {
    return <div className="site-monogram" aria-hidden="true">{letter}</div>;
  }
  return (
    <div className="site-favicon" aria-hidden="true">
      <img
        src={candidates[idx]}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setIdx((i) => i + 1)}
        onLoad={(e) => {
          // Some sites answer /favicon.ico with a 1x1 placeholder (or a blank
          // tracking pixel) that "loads" fine but shows as an empty circle.
          // Treat anything tinier than a real icon as a miss and move on.
          const img = e.currentTarget;
          if (img.naturalWidth > 0 && img.naturalWidth < 8) setIdx((i) => i + 1);
        }}
      />
    </div>
  );
}

const HOUR_MS = 3_600_000;
const SERIES_COLORS = ["#ff6b3d", "#3868ff", "#51a53e", "#a24bff", "#e0a400", "#d6336c", "#0f9b8e"];

type Ack = { stamp: string; at: string };
type ChartView = "lanes" | "cumulative" | "hours";
const CHART_RANGES = [1, 6, 24, 72, 168, 336]; // hours: 1h / 6h / 24h / 3d / 7d / 14d

// How many visible lines a "changed" event touched, parsed from the backend's
// summary ("追加された内容（N件）" / "なくなった内容（N件）"). Reorder-only
// changes carry no counts, so they weigh 0.
function eventMagnitude(summary: string): number {
  const added = summary.match(/追加された内容（(\d+)件）/);
  const removed = summary.match(/なくなった内容（(\d+)件）/);
  return (added ? +added[1] : 0) + (removed ? +removed[1] : 0);
}

type ChartDatum = { t: number; mag: number };
type ChartSeries = { id: number; name: string; color: string; points: ChartDatum[] };
type TimeTick = { ms: number; label: string };

function TimeGrid({ ticks }: { ticks: TimeTick[] }) {
  const first = ticks[0]?.ms;
  const last = ticks[ticks.length - 1]?.ms;
  if (first == null || last == null || first === last) return null;
  return <>{ticks.slice(1, -1).map((tick) => (
    <span
      key={tick.ms}
      className="time-grid-line"
      style={{ left: `${((tick.ms - first) / (last - first)) * 100}%` }}
      aria-hidden="true"
    />
  ))}</>;
}

function ChartAxis({ ticks, cumulative = false }: { ticks: TimeTick[]; cumulative?: boolean }) {
  return <div className={`chart-axis${cumulative ? " chart-axis-cum" : ""}`}>
    {ticks.map((tick) => <span key={tick.ms}>{tick.label}</span>)}
  </div>;
}

function CheckTimeline({
  checks,
  startMs,
  spanMs,
  ticks,
  clock,
  t,
}: {
  checks: CheckRun[];
  startMs: number;
  spanMs: number;
  ticks: TimeTick[];
  clock: (ms: number) => string;
  t: Dict;
}) {
  const visible = checks
    .map((check) => ({ ...check, time: Date.parse(check.checked_at) }))
    .filter((check) => check.time >= startMs && check.time <= startMs + spanMs);
  return (
    <div className="check-lane">
      <span className="check-lane-name">{t.checkLane}</span>
      <div className="check-lane-strip">
        <TimeGrid ticks={ticks} />
        {visible.map((check, index) => (
          <i
            key={`${check.checked_at}-${index}`}
            className={`check-tick check-tick-${check.status}`}
            style={{ left: `${((check.time - startMs) / spanMs) * 100}%` }}
            title={`${clock(check.time)} · ${t.checkResult[check.status] || check.status} · ${t.checkPages(check.page_count)}`}
          />
        ))}
      </div>
      <b className="check-lane-count">{t.checksCount(visible.length)}</b>
    </div>
  );
}

// Change-activity view with switchable shapes (lanes / cumulative / by-hour)
// and an adjustable time window. "changed" events are the only series we keep.
// `compact` drops the big header for embedding inside an expanded site row.
function ActivityChart({ events, checks, t, lang, compact, markTime, markLabel }: { events: EventItem[]; checks: CheckRun[]; t: Dict; lang: Lang; compact?: boolean; markTime?: number; markLabel?: string }) {
  const [view, setView] = useState<ChartView>("lanes");
  const [rangeH, setRangeH] = useState(6);
  const now = Date.now();
  const spanMs = rangeH * HOUR_MS;
  const startMs = now - spanMs;

  const bySite = new Map<number, ChartSeries>();
  for (const event of events) {
    if (event.kind !== "changed") continue;
    const time = Date.parse(event.created_at);
    if (!(time >= startMs && time <= now)) continue;
    let entry = bySite.get(event.site_id);
    if (!entry) {
      entry = { id: event.site_id, name: event.site_name, color: "", points: [] };
      bySite.set(event.site_id, entry);
    }
    entry.points.push({ t: time, mag: eventMagnitude(event.summary) });
  }
  const series = [...bySite.values()]
    .sort((a, b) => a.id - b.id)
    .map((s, i) => ({ ...s, color: SERIES_COLORS[i % SERIES_COLORS.length] }));
  const total = series.reduce((sum, s) => sum + s.points.length, 0);

  const pad = (n: number) => String(n).padStart(2, "0");
  const timeAxis = (ms: number) => {
    const d = new Date(ms);
    return rangeH <= 24 ? `${d.getHours()}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const clock = (ms: number) => {
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${pad(d.getMinutes())}`;
  };
  const rangeLabel = (h: number) =>
    h < 24 ? (lang === "ja" ? `${h}時間` : `${h}h`) : h === 24 ? (lang === "ja" ? "24時間" : "24h") : lang === "ja" ? `${h / 24}日` : `${h / 24}d`;
  const sub = view === "lanes" ? t.subLanes : view === "cumulative" ? t.subCumulative : t.subHours;
  const markInRange = markTime != null && markTime >= startMs && markTime <= now;
  // Short spans expose minute-level timing. Longer spans still show enough
  // reference marks to locate a point without relying on hover text alone.
  const tickCount = rangeH <= 1 ? 4 : rangeH <= 6 ? 6 : rangeH <= 24 ? 6 : 4;
  const timeTicks: TimeTick[] = Array.from({ length: tickCount + 1 }, (_, index) => {
    const ms = startMs + (spanMs * index) / tickCount;
    return { ms, label: index === tickCount ? `${t.nowLabel} ${timeAxis(ms)}` : timeAxis(ms) };
  });

  return (
    <section className={`chart-card${compact ? " chart-card-compact" : ""}`} aria-label={t.chartTitle}>
      {!compact && (
        <div className="chart-head">
          <div><p className="eyebrow">{t.chartKicker}</p><h2>{t.chartTitle}</h2></div>
          <span className="chart-total">{total}<small>{t.chartUnit}</small></span>
        </div>
      )}

      <div className="chart-controls">
        <div className="seg" role="tablist" aria-label={t.viewAria}>
          {(["lanes", "cumulative", "hours"] as ChartView[]).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              className={view === v ? "seg-on" : ""}
              onClick={() => setView(v)}
            >
              {v === "lanes" ? t.viewLanes : v === "cumulative" ? t.viewCumulative : t.viewHours}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label={t.rangeAria}>
          {CHART_RANGES.map((h) => (
            <button key={h} aria-pressed={rangeH === h} className={rangeH === h ? "seg-on" : ""} onClick={() => setRangeH(h)}>
              {rangeLabel(h)}
            </button>
          ))}
        </div>
      </div>

      <p className="check-graph-hint">{t.checkGraphHint}</p>
      <CheckTimeline checks={checks} startMs={startMs} spanMs={spanMs} ticks={timeTicks} clock={clock} t={t} />

      {total === 0 ? (
        <>
          <p className="chart-empty">{t.chartEmpty}</p>
          {view !== "hours" && <ChartAxis ticks={timeTicks} cumulative={view === "cumulative"} />}
        </>
      ) : (
        <>
          <p className="chart-sub">
            {sub}
            {markInRange && view !== "hours" && <span className="mark-note"> · {markLabel} {clock(markTime!)}</span>}
          </p>
          {view === "lanes" && <LaneView series={series} startMs={startMs} spanMs={spanMs} ticks={timeTicks} clock={clock} markPct={markInRange ? ((markTime! - startMs) / spanMs) * 100 : null} />}
          {view === "cumulative" && <CumulativeView series={series} startMs={startMs} spanMs={spanMs} now={now} ticks={timeTicks} clock={clock} markTime={markInRange ? markTime! : null} />}
          {view === "hours" && <HoursView series={series} />}
          {view === "hours" ? (
            <div className="chart-axis chart-axis-hours">
              {t.hoursAxis.map((h, i) => <span key={i}>{h}</span>)}
            </div>
          ) : <ChartAxis ticks={timeTicks} cumulative={view === "cumulative"} />}
        </>
      )}
    </section>
  );
}

// A: one lane per site, a dot at each detection time, dot area ∝ magnitude.
function LaneView({ series, startMs, spanMs, ticks, clock, markPct }: { series: ChartSeries[]; startMs: number; spanMs: number; ticks: TimeTick[]; clock: (ms: number) => string; markPct?: number | null }) {
  const maxMag = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.mag)));
  return (
    <div className="lane-chart">
      {series.map((s) => (
        <div className="lane" key={s.id}>
          <span className="lane-name">{s.name}</span>
          <div className="lane-strip">
            <TimeGrid ticks={ticks} />
            {markPct != null && <span className="lane-mark" style={{ left: `${markPct}%` }} />}
            {s.points.map((p, i) => {
              const d = 7 + 11 * Math.sqrt(p.mag / maxMag);
              return (
                <i
                  key={i}
                  style={{ left: `${((p.t - startMs) / spanMs) * 100}%`, width: d, height: d, background: s.color }}
                  title={`${clock(p.t)} · ${p.mag}`}
                />
              );
            })}
          </div>
          <b className="lane-count">{s.points.reduce((a, p) => a + p.mag, 0)}</b>
        </div>
      ))}
    </div>
  );
}

// D: cumulative lines-changed as a per-site step line.
function CumulativeView({ series, startMs, spanMs, now, ticks, clock, markTime }: { series: ChartSeries[]; startMs: number; spanMs: number; now: number; ticks: TimeTick[]; clock: (ms: number) => string; markTime?: number | null }) {
  const W = 820, H = 168, padL = 34, padR = 8, padT = 10, padB = 8;
  const totals = series.map((s) => s.points.reduce((a, p) => a + p.mag, 0));
  const yMax = Math.max(1, ...totals);
  const xS = (ms: number) => padL + ((ms - startMs) / spanMs) * (W - padL - padR);
  const yS = (v: number) => padT + (1 - v / yMax) * (H - padT - padB);
  return (
    <svg className="line-chart" viewBox={`0 0 ${W} ${H}`} role="img">
      {markTime != null && (
        <line className="mark-line" x1={xS(markTime)} y1={padT} x2={xS(markTime)} y2={H - padB} vectorEffect="non-scaling-stroke" />
      )}
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line className={`grid-line${f ? " grid-top" : ""}`} x1={padL} y1={yS(yMax * f)} x2={W - padR} y2={yS(yMax * f)} vectorEffect="non-scaling-stroke" />
          <text className="y-label" x={padL - 5} y={yS(yMax * f) + 3} textAnchor="end">{Math.round(yMax * f)}</text>
        </g>
      ))}
      {ticks.slice(1, -1).map((tick) => (
        <line key={tick.ms} className="grid-line grid-vertical" x1={xS(tick.ms)} y1={padT} x2={xS(tick.ms)} y2={H - padB} vectorEffect="non-scaling-stroke" />
      ))}
      {series.map((s) => {
        const pts = [...s.points].sort((a, b) => a.t - b.t);
        let cum = 0;
        let d = `M ${xS(startMs)} ${yS(0)}`;
        const dots: { x: number; y: number; p: ChartDatum; cum: number }[] = [];
        for (const p of pts) {
          d += ` L ${xS(p.t)} ${yS(cum)}`;
          cum += p.mag;
          d += ` L ${xS(p.t)} ${yS(cum)}`;
          dots.push({ x: xS(p.t), y: yS(cum), p, cum });
        }
        d += ` L ${xS(now)} ${yS(cum)}`;
        return (
          <g key={s.id}>
            <path className="series-line" d={d} style={{ stroke: s.color }} vectorEffect="non-scaling-stroke" />
            {dots.map((dt, i) => (
              <circle key={i} cx={dt.x} cy={dt.y} r={3} style={{ fill: s.color }}>
                <title>{`${s.name} · ${clock(dt.p.t)} · +${dt.p.mag} (累計 ${dt.cum})`}</title>
              </circle>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

// Always-on row punchcard: this site's changes over the last 7 days folded onto
// the 24 hours of the day (cell opacity ∝ magnitude). Shows *when* — the
// time-of-day a site tends to change — at a glance. Left edge = 0:00.
function MiniTrend({ events, days = 7 }: { events: EventItem[]; days?: number }) {
  const start = Date.now() - days * 24 * HOUR_MS;
  const byHour = Array<number>(24).fill(0);
  for (const e of events) {
    if (e.kind !== "changed") continue;
    const t = Date.parse(e.created_at);
    if (t < start) continue;
    byHour[new Date(t).getHours()] += eventMagnitude(e.summary);
  }
  const max = Math.max(1, ...byHour);
  return (
    <div className="mini-trend" aria-hidden="true" title="0–23時の変化（左=0時）">
      {byHour.map((v, h) => (
        <i key={h} style={v > 0 ? { background: "var(--orange)", opacity: 0.25 + 0.75 * (v / max) } : undefined} />
      ))}
    </div>
  );
}

// C: punchcard — site × hour-of-day, cell opacity ∝ magnitude in that hour.
function HoursView({ series }: { series: ChartSeries[] }) {
  const maxCell = Math.max(
    1,
    ...series.map((s) => {
      const row = Array<number>(24).fill(0);
      for (const p of s.points) row[new Date(p.t).getHours()] += p.mag;
      return Math.max(...row);
    }),
  );
  return (
    <div className="heat-chart">
      {series.map((s) => {
        const row = Array<number>(24).fill(0);
        for (const p of s.points) row[new Date(p.t).getHours()] += p.mag;
        return (
          <div className="heat-row" key={s.id}>
            <span className="heat-name">{s.name}</span>
            <div className="heat-cells">
              {row.map((v, h) => (
                <i
                  key={h}
                  className="heat-cell"
                  style={v > 0 ? { background: s.color, opacity: 0.25 + 0.75 * (v / maxCell) } : undefined}
                  title={v > 0 ? `${s.name} · ${h}:00 · ${v}` : undefined}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function App() {
  const [isAdmin] = useState(detectAdmin);
  const [lang, setLang] = useState<Lang>(detectLang);
  const t = T[lang];
  const [source, setSource] = useState<SourceKind>(() => defaultSource(isAdmin));
  const backend: Backend = useMemo(
    () => (source === "cloud" ? new CloudBackend() : new LocalBackend()),
    [source],
  );
  const [state, setState] = useState<AppState>(emptyState);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [interval, setIntervalValue] = useState(60);
  const [discoveryDepth, setDiscoveryDepth] = useState(1);
  const [pageDrafts, setPageDrafts] = useState<Record<number, string[]>>({});
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const cloudDialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [tokenDraft, setTokenDraft] = useState("");
  const [hasToken, setHasToken] = useState(() => !!getCloudToken());
  const [connError, setConnError] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [pageUrl, setPageUrl] = useState("");

  // Detected changes are separate from short-lived check/error activity so a
  // site's complete update content never disappears from its detail view.
  const updatesBySite = useMemo(() => {
    const map = new Map<number, EventItem[]>();
    for (const event of state.updates) {
      const list = map.get(event.site_id);
      if (list) list.push(event);
      else map.set(event.site_id, [event]);
    }
    return map;
  }, [state.updates]);

  // "Seen" markers for changed sites, kept per-browser (like the cloud token).
  // We remember which change was acknowledged — the site's last_changed stamp —
  // so the badge quiets down until a *new* change produces a fresh stamp.
  // Separate keys per source: local and cloud use unrelated site ids.
  const ackKey = `pagewatch-ack-${source}`;
  const [acks, setAcks] = useState<Record<string, Ack>>({});
  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(ackKey) || "{}");
      // Migrate the old shape {id: stamp} to {id: {stamp, at}} so upgrades keep
      // existing acknowledgements (with an unknown time).
      const next: Record<string, Ack> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "string") next[k] = { stamp: v, at: "" };
        else if (v && typeof v === "object" && "stamp" in v) next[k] = v as Ack;
      }
      setAcks(next);
    } catch {
      setAcks({});
    }
  }, [ackKey]);

  const ackStamp = (site: Site) => site.last_changed || site.last_checked || "";
  const isAcked = (site: Site) => site.status === "changed" && acks[String(site.id)]?.stamp === ackStamp(site);
  // When the site was last marked read — kept even after a newer change flips it
  // back to "changed", so the chart can show "updates since you last looked".
  const lastAckAt = (site: Site) => acks[String(site.id)]?.at || "";
  // How many changes were detected after the site was last marked read.
  const updatesSince = (site: Site, sinceIso: string) => {
    if (!sinceIso) return 0;
    const since = Date.parse(sinceIso);
    return (updatesBySite.get(site.id) ?? []).filter(
      (e) => e.kind === "changed" && Date.parse(e.created_at) > since,
    ).length;
  };
  const displayStatus = (site: Site) => (isAcked(site) ? "seen" : site.status);
  const unackedChanged = state.sites.filter((s) => s.status === "changed" && !isAcked(s));

  const saveAcks = (next: Record<string, Ack>) => {
    setAcks(next);
    localStorage.setItem(ackKey, JSON.stringify(next));
  };
  const ackSite = (site: Site) => saveAcks({ ...acks, [String(site.id)]: { stamp: ackStamp(site), at: new Date().toISOString() } });
  const ackAll = () => {
    const at = new Date().toISOString();
    const next = { ...acks };
    for (const site of unackedChanged) next[String(site.id)] = { stamp: ackStamp(site), at };
    saveAcks(next);
  };

  const toggleLang = () => {
    const next: Lang = lang === "ja" ? "en" : "ja";
    localStorage.setItem(LANG_KEY, next);
    document.documentElement.lang = next;
    setLang(next);
  };

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const loadState = useCallback(
    async (quiet = false) => {
      try {
        const next = await backend.loadState();
        setState(next);
        setConnError(false);
        if (next.settings) {
          setSettings((current) =>
            settingsDialog.current?.open ? current : { ...next.settings!, smtp_password: "" },
          );
        }
      } catch (error) {
        setConnError(true);
        if (!quiet) setMessage(error instanceof Error ? error.message : t.tConnErr);
      } finally {
        setLoading(false);
      }
    },
    [backend, t],
  );

  // What the person needs to do before this mode can work.
  const setupNeeded: "local-offline" | "cloud-token" | null =
    backend.kind === "cloud" && !hasToken
      ? "cloud-token"
      : backend.kind === "local" && connError
        ? "local-offline"
        : null;

  useEffect(() => {
    setState(emptyState);
    setLoading(true);
    loadState();
    const period = backend.kind === "cloud" ? 20000 : 5000;
    const timer = window.setInterval(() => loadState(true), period);
    return () => window.clearInterval(timer);
  }, [backend, loadState]);

  useEffect(() => {
    if (!backend.intervalChoices.some((c) => c.value === interval)) {
      setIntervalValue(60);
    }
  }, [backend, interval]);

  const switchSource = (next: SourceKind) => {
    localStorage.setItem(SOURCE_KEY, next);
    setSource(next);
    if (next === "cloud" && !getCloudToken()) {
      setTokenDraft("");
      cloudDialog.current?.showModal();
    }
  };

  const showMessage = (value: string) => {
    setMessage(value);
    window.setTimeout(() => setMessage(null), 4500);
  };

  const run = async (key: string, action: () => Promise<string | void>, reload = true) => {
    setBusy(key);
    try {
      const result = await action();
      if (typeof result === "string") showMessage(result);
      if (reload) await loadState();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t.tActionErr);
    } finally {
      setBusy(null);
    }
  };

  const addSite = (event: FormEvent) => {
    event.preventDefault();
    // Validate on the client for both backends so the URL rules and messages
    // are identical whether the check runs locally or in the cloud.
    const trimmedUrl = url.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmedUrl);
    } catch {
      showMessage(t.tBadUrl);
      return;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      showMessage(t.tBadUrl);
      return;
    }
    if (state.sites.some((s) => s.url === trimmedUrl)) {
      showMessage(t.tDupUrl);
      return;
    }
    run("add", async () => {
      await backend.addSite({ name, url: trimmedUrl, interval_minutes: interval, discovery_depth: discoveryDepth });
      setName("");
      setUrl("");
      return backend.kind === "cloud" ? t.tAddCloud : t.tAddLocal;
    });
  };

  const deleteSite = (site: Site) => {
    if (!window.confirm(t.confirmDelete(site.name))) return;
    run(`delete-${site.id}`, async () => {
      await backend.deleteSite(site);
      return t.tDeleted;
    });
  };

  const addPage = (event: FormEvent, site: Site) => {
    event.preventDefault();
    const value = pageUrl.trim();
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
      showMessage(t.tBadUrl);
      return;
    }
    if (site.urls.includes(value)) {
      showMessage(t.tDupUrl);
      return;
    }
    run(`add-page-${site.id}`, async () => {
      await backend.addPage(site, value);
      setPageUrl("");
      return t.tPageAdded;
    });
  };

  const draftPages = (site: Site) => pageDrafts[site.id] ?? site.urls;
  const pageSelectionChanged = (site: Site) => {
    const draft = draftPages(site);
    return draft.length !== site.urls.length || draft.some((page) => !site.urls.includes(page));
  };
  const setPageEnabled = (site: Site, page: string, enabled: boolean) => {
    const selected = draftPages(site);
    const next = enabled
      ? Array.from(new Set([...selected, page]))
      : selected.filter((url) => url !== page);
    setPageDrafts((drafts) => ({ ...drafts, [site.id]: next }));
  };
  const setAllPages = (site: Site, includeChildren: boolean) => {
    setPageDrafts((drafts) => ({
      ...drafts,
      [site.id]: includeChildren ? site.discovered_urls : [site.url],
    }));
  };
  const savePageSelection = (site: Site) => {
    const selected = draftPages(site);
    run(`pages-${site.id}`, async () => {
      await backend.setPages(site, selected);
      setPageDrafts((drafts) => {
        const next = { ...drafts };
        delete next[site.id];
        return next;
      });
      return t.tPageSelection;
    });
  };

  const startRename = (site: Site) => {
    setEditingId(site.id);
    setEditName(site.name);
  };

  const commitRename = (site: Site) => {
    // Escape and Enter both clear editingId synchronously, so a stray blur that
    // fires afterwards would otherwise re-commit (double save) or resurrect a
    // cancelled edit. Bail out unless this row is still the one being edited.
    if (editingId !== site.id) return;
    const value = editName.trim();
    setEditingId(null);
    if (!value || value === site.name) return;
    run(`rename-${site.id}`, async () => {
      await backend.renameSite(site, value);
      return t.tRenamed;
    });
  };

  const openSettings = () => {
    if (backend.kind === "cloud") {
      setTokenDraft(getCloudToken());
      cloudDialog.current?.showModal();
    } else {
      if (state.settings) setSettings({ ...state.settings, smtp_password: "" });
      settingsDialog.current?.showModal();
    }
  };

  const saveToken = (event: FormEvent) => {
    event.preventDefault();
    setCloudToken(tokenDraft);
    setHasToken(!!tokenDraft.trim());
    cloudDialog.current?.close();
    showMessage(tokenDraft ? t.tTokenSaved : t.tTokenRemoved);
    loadState();
  };

  const local = backend.kind === "local" ? (backend as LocalBackend) : null;

  const saveEmailSettings = (event: FormEvent) => {
    event.preventDefault();
    run("settings", async () => {
      if (!local) return;
      const saved = await local.saveSettings(settings);
      setSettings({ ...saved, smtp_password: "" });
      settingsDialog.current?.close();
      return t.tSettingsSaved;
    });
  };

  const testEmail = () => {
    run(
      "test-email",
      async () => {
        if (!local) return;
        await local.saveSettings(settings);
        await local.testEmail();
        return t.tTestSent;
      },
      false,
    );
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label={t.home}>
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>PAGEWATCH <small>v{APP_VERSION}</small></span>
        </a>
        <div className="top-actions">
          {isAdmin && (
            <div className="source-toggle" role="tablist" aria-label={t.srcAria}>
              <button
                role="tab"
                aria-selected={source === "local"}
                className={source === "local" ? "source-active" : ""}
                onClick={() => switchSource("local")}
              >
                {t.srcLocal}
              </button>
              <button
                role="tab"
                aria-selected={source === "cloud"}
                className={source === "cloud" ? "source-active" : ""}
                onClick={() => switchSource("cloud")}
              >
                {t.srcCloud}
              </button>
            </div>
          )}
          <button className="lang-button" onClick={toggleLang} aria-label={t.langAria}>
            {lang === "ja" ? "EN" : "日本語"}
          </button>
          <button className="icon-button" onClick={openSettings} aria-label={t.settings} title={t.settings}>
            ⚙
          </button>
        </div>
      </header>

      <main id="top">
        {setupNeeded === "local-offline" && (
          <section className="setup-card" aria-label={t.loTitle}>
            <p className="eyebrow">{t.loKicker}</p>
            <h2>{t.loTitle}</h2>
            <p className="setup-lead">{t.loLead}</p>
            <ol>
              <li>{t.loStep1}</li>
              <li>{t.loStep2a}<code>Page-Watch-main.zip</code>{t.loStep2b}</li>
              <li>{t.loStep3a}<code>start.command</code>{t.loStep3b}</li>
              <li>
                <strong>{t.loStep4head}</strong>{t.loStep4note}
                <small>{t.loStep4a}</small>
                <small>{t.loStep4b}</small>
                <small>{t.loStep4c}</small>
                <small>{t.loStep4d}</small>
              </li>
              <li>
                {t.loStep5}
                <small>{t.loStep5note}</small>
              </li>
            </ol>
            <div className="setup-actions">
              <a className="setup-button" href={DOWNLOAD_URL}>{t.loDownload}</a>
              <button className="secondary-button" onClick={() => run("reload", () => loadState(), false)}>
                <span className={busy === "reload" ? "spin" : ""}>↻</span> {t.reload}
              </button>
            </div>
            <details className="setup-alt">
              <summary>{t.loAltSummary}</summary>
              <p>{t.loAltP1}</p>
              <p><code>xattr -dr com.apple.quarantine </code>{t.loAltDrag}</p>
              <p>{t.loAltP2a}<code>start.command</code>{t.loAltP2b}</p>
            </details>
          </section>
        )}
        {setupNeeded === "cloud-token" && (
          <section className="setup-card" aria-label={t.ctTitle}>
            <p className="eyebrow">{t.ctKicker}</p>
            <h2>{t.ctTitle}</h2>
            <p className="setup-lead">{t.ctLead}</p>
            <ol>
              <li>
                {t.ctStep1}
                <small>{t.ctStep1note}</small>
              </li>
              <li>{t.ctStep2}</li>
              <li>{t.ctStep3}<small>{t.ctStep3note}</small></li>
            </ol>
            <div className="setup-actions">
              <a className="setup-button" href={TOKEN_URL} target="_blank" rel="noreferrer">{t.ctCreate}</a>
              <button
                className="secondary-button"
                onClick={() => {
                  setTokenDraft(getCloudToken());
                  cloudDialog.current?.showModal();
                }}
              >
                {t.ctEnter}
              </button>
            </div>
          </section>
        )}
        <div className="layout">
        <aside className="side">
        <section className="add-panel" aria-labelledby="add-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{t.addKicker}</p>
              <h2 id="add-title">{t.addTitle}</h2>
            </div>
          </div>
          <form className="add-form" onSubmit={addSite}>
            <label className="field field-url">
              <span>{t.fUrl}</span>
              <input
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/news"
                required
              />
            </label>
            <label className="field field-name">
              <span>{t.fName} <small>{t.optional}</small></span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t.phName} />
            </label>
            <label className="field field-interval">
              <span>{t.fInterval}</span>
              <select value={interval} onChange={(event) => setIntervalValue(Number(event.target.value))}>
                {backend.intervalChoices.map((choice) => (
                  <option key={choice.value} value={choice.value}>{fmtInterval(choice.value, lang)}</option>
                ))}
              </select>
            </label>
            <label className="field field-discovery">
              <span>{t.fDiscovery}</span>
              <select value={discoveryDepth} onChange={(event) => setDiscoveryDepth(Number(event.target.value))}>
                <option value={0}>{t.discoveryNone}</option>
                <option value={1}>{t.discoveryOne}</option>
                <option value={2}>{t.discoveryTwo}</option>
              </select>
            </label>
            <button className="primary-button" type="submit" disabled={busy === "add"}>
              <span>{busy === "add" ? t.addBtnBusy : t.addBtn}</span><b aria-hidden="true">↗</b>
            </button>
          </form>
        </section>
        </aside>

        <div className="content">
        <section className="dashboard-section" aria-labelledby="watch-title">
          <div className="section-title-row">
            <div className="title-with-index">
              <div><p className="eyebrow">{t.watchKicker}</p><h2 id="watch-title">{t.watchTitle}</h2></div>
            </div>
            <div className="section-title-actions">
              {unackedChanged.length > 0 && (
                <button className="secondary-button" onClick={ackAll}>
                  {t.ackAll}
                </button>
              )}
              <button
                className="secondary-button"
                onClick={() => run("all", () => backend.checkAll(), false)}
                disabled={busy === "all"}
              >
                <span className={busy === "all" ? "spin" : ""}>↻</span> {t.checkAll}
              </button>
            </div>
          </div>

          <div className="site-list" aria-live="polite">
            {loading ? (
              <div className="empty-state"><span className="loader" /> {t.loadingList}</div>
            ) : state.sites.length === 0 ? (
              <div className="empty-state">{t.emptyList}</div>
            ) : state.sites.map((site) => {
              const siteUpdates = updatesBySite.get(site.id) ?? [];
              const open = expandedId === site.id;
              const toggle = () => setExpandedId(open ? null : site.id);
              const ackAt = lastAckAt(site);
              const sinceCount = updatesSince(site, ackAt);
              const nextCheck = nextCheckInfo(site, lang, t);
              return (
              <div className="site-group" key={site.id}>
              <article
                className={`site-row ${!site.enabled ? "site-paused" : ""} ${open ? "site-open" : ""}`}
                onClick={(e) => {
                  // Clicking anywhere on the row expands it, except on the
                  // controls it already carries (rename, badge, link, select…).
                  if (!(e.target as HTMLElement).closest('button, a, select, input, [role="button"]')) toggle();
                }}
              >
                <button
                  className="row-chevron"
                  onClick={(e) => { e.stopPropagation(); toggle(); }}
                  aria-expanded={open}
                  aria-label={t.expandAria}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                </button>
                <SiteIcon site={site} />
                <div className="site-info">
                  <div className="site-name-line">
                    {editingId === site.id ? (
                      <input
                        className="name-edit"
                        value={editName}
                        autoFocus
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(site);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        onBlur={() => commitRename(site)}
                        aria-label={t.fName}
                      />
                    ) : (
                      <h3
                        className="site-name"
                        role="button"
                        tabIndex={0}
                        onClick={() => startRename(site)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            startRename(site);
                          }
                        }}
                        title={t.renameHint}
                        aria-label={`${site.name} — ${t.renameHint}`}
                      >
                        {site.name}
                      </h3>
                    )}
                    <StatusBadge
                      status={displayStatus(site)}
                      t={t}
                      onAck={site.status === "changed" && !isAcked(site) ? () => ackSite(site) : undefined}
                    />
                    {ackAt && (
                      sinceCount > 0 ? (
                        <span className="since-note since-new">{t.sinceUpdates(formatDate(ackAt, lang, t), sinceCount)}</span>
                      ) : (
                        <span className="since-note">{t.seenAt(formatDate(ackAt, lang, t))}</span>
                      )
                    )}
                  </div>
                  <a href={site.url} target="_blank" rel="noreferrer">{hostname(site.url)} <span>↗</span></a>
                  <small className="page-count">{t.pages(site.page_count)}</small>
                  {site.last_error && <p className="site-error">{site.last_error}</p>}
                </div>
                <div className="site-meta">
                  <div className="check-time-block">
                    <span>{t.lastChecked}</span>
                    <strong>{formatRelative(site.last_checked, lang, t)}</strong>
                    <small>{formatDate(site.last_checked, lang, t)}</small>
                  </div>
                  <div className={`next-check-block${nextCheck.overdue ? " next-check-overdue" : ""}`}>
                    <span>{t.nextCheck}</span>
                    <strong>{nextCheck.primary}</strong>
                    {nextCheck.detail && <small>{nextCheck.detail}</small>}
                  </div>
                  <select
                    className="interval-select"
                    value={site.interval_minutes}
                    onChange={(event) =>
                      run(`interval-${site.id}`, async () => {
                        await backend.setInterval(site, Number(event.target.value));
                        return t.tIntervalChanged;
                      })
                    }
                    disabled={busy === `interval-${site.id}`}
                    aria-label={t.fInterval}
                  >
                    {backend.intervalChoices.map((choice) => (
                      <option key={choice.value} value={choice.value}>{t.every(fmtInterval(choice.value, lang))}</option>
                    ))}
                    {!backend.intervalChoices.some((c) => c.value === site.interval_minutes) && (
                      <option value={site.interval_minutes}>{t.every(fmtInterval(site.interval_minutes, lang))}</option>
                    )}
                  </select>
                </div>
                <MiniTrend events={siteUpdates} />
                <div className="site-actions">
                  <button
                    onClick={() => run(`check-${site.id}`, () => backend.checkSite(site))}
                    disabled={busy === `check-${site.id}` || !site.enabled}
                    title={t.checkNow}
                    aria-label={t.checkNow}
                  >
                    <IconRefresh spin={busy === `check-${site.id}`} />
                  </button>
                  <button
                    onClick={() => run(`toggle-${site.id}`, () => backend.toggleSite(site))}
                    disabled={busy === `toggle-${site.id}`}
                    title={site.enabled ? t.pause : t.resume}
                    aria-label={site.enabled ? t.pause : t.resume}
                  >
                    {site.enabled ? <IconPause /> : <IconPlay />}
                  </button>
                  <button className="danger-action" onClick={() => deleteSite(site)} disabled={busy === `delete-${site.id}`} title={t.del} aria-label={t.del}><IconTrash /></button>
                </div>
              </article>
              {open && (
                <div className="site-detail">
                  <section className="page-manager">
                    <div className="page-manager-heading">
                      <div>
                        <p className="eyebrow">{t.pageUrls}</p>
                        <p className="page-select-hint">{t.pageSelectHint}</p>
                      </div>
                      <strong>{t.pageSelectionCount(draftPages(site).length, site.discovered_urls.length)}</strong>
                    </div>
                    <ul>
                      {site.discovered_urls.map((page) => (
                        <li key={page} className={`page-choice${page === site.url ? " page-root" : ""}`}>
                          <label>
                            <input
                              type="checkbox"
                              checked={draftPages(site).includes(page)}
                              disabled={page === site.url || busy === `pages-${site.id}`}
                              onChange={(event) => setPageEnabled(site, page, event.target.checked)}
                            />
                            <span className="page-url-copy">
                              <a href={page} target="_blank" rel="noreferrer" title={page}>
                                {page === site.url ? t.rootPage : pageLabel(page)}
                              </a>
                              {page !== site.url && <small title={page}>{page}</small>}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                    <div className="page-selection-actions">
                      <div>
                        <button type="button" className="text-button" onClick={() => setAllPages(site, true)}>
                          {t.selectAllPages}
                        </button>
                        <button type="button" className="text-button" onClick={() => setAllPages(site, false)}>
                          {t.clearChildPages}
                        </button>
                      </div>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => savePageSelection(site)}
                        disabled={!pageSelectionChanged(site) || busy === `pages-${site.id}`}
                      >
                        {busy === `pages-${site.id}` ? t.savingPageSelection : t.savePageSelection}
                      </button>
                    </div>
                    <form onSubmit={(event) => addPage(event, site)}>
                      <input
                        type="url"
                        value={expandedId === site.id ? pageUrl : ""}
                        onChange={(event) => setPageUrl(event.target.value)}
                        placeholder="https://example.com/news"
                        aria-label={t.pageUrl}
                        required
                      />
                      <button type="submit" className="secondary-button" disabled={busy === `add-page-${site.id}`}>
                        {t.addPage}
                      </button>
                    </form>
                  </section>
                  <ActivityChart
                    events={siteUpdates}
                    checks={site.checks}
                    t={t}
                    lang={lang}
                    compact
                    markTime={lastAckAt(site) ? Date.parse(lastAckAt(site)) : undefined}
                    markLabel={t.status.seen}
                  />
                  <section className="check-history-panel">
                    <div className="check-history-heading">
                      <div>
                        <p className="eyebrow">{t.checkHistory}</p>
                        <p>{t.checkHistoryHint}</p>
                      </div>
                      <strong>{t.checksCount(site.checks.length)}</strong>
                    </div>
                    {site.checks.length === 0 ? (
                      <p className="check-history-empty">{t.checkHistoryEmpty}</p>
                    ) : (
                      <div className="check-history-list">
                        {site.checks.slice(0, 10).map((check, index) => (
                          <article key={`${check.checked_at}-${index}`}>
                            <span className={`check-history-mark check-history-${check.status}`} />
                            <time title={formatDate(check.checked_at, lang, t)}>
                              <strong>{formatRelative(check.checked_at, lang, t)}</strong>
                              <small>{formatDate(check.checked_at, lang, t)}</small>
                            </time>
                            <span>{t.checkResult[check.status] || check.status}</span>
                            <small>{t.checkPages(check.page_count)}</small>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>
                  <div className="detail-history">
                    <div className="update-history-heading">
                      <div>
                        <p className="eyebrow">{t.histKicker}</p>
                        <h3>{t.histTitle}</h3>
                        <p>{t.histHint}</p>
                      </div>
                      <strong>{t.updatesCount(siteUpdates.length)}</strong>
                    </div>
                    <div className="timeline">
                      {siteUpdates.length === 0 ? (
                        <p className="timeline-empty">{t.histEmpty}</p>
                      ) : siteUpdates.map((item) => (
                        <article className="timeline-item" key={item.id}>
                          <span className={`timeline-mark mark-${item.kind}`} />
                          <time>{formatDate(item.created_at, lang, t)}</time>
                          <p>{item.summary}</p>
                          <span className="event-label">
                            {t.evChanged}
                          </span>
                        </article>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              </div>
              );
            })}
          </div>
        </section>
        </div>
        </div>
      </main>

      <footer>
        <span>PAGEWATCH / {source === "cloud" ? t.footerSrcCloud : t.footerSrcLocal}</span>
        <p>{source === "cloud" ? t.footerCloud : t.footerLocal}</p>
        <a href="#top">{t.top}</a>
      </footer>

      <dialog className="settings-dialog" ref={cloudDialog}>
        <form onSubmit={saveToken}>
          <div className="dialog-heading">
            <div><p className="eyebrow">{t.cdKicker}</p><h2>{t.cdTitle}</h2></div>
            <button type="button" onClick={() => cloudDialog.current?.close()} aria-label={t.close}>×</button>
          </div>
          <div className="email-fields">
            <label>
              <span>{t.cdTokenLabel}</span>
              <input
                type="password"
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
                placeholder="github_pat_..."
              />
            </label>
            <p className="dialog-note">{t.cdNote1}</p>
            <p className="dialog-note">{t.cdNote2}</p>
          </div>
          <div className="dialog-actions">
            <button type="submit" className="primary-button"><span>{t.save}</span><b>↗</b></button>
          </div>
        </form>
      </dialog>

      <dialog className="settings-dialog" ref={settingsDialog} onClose={() => state.settings && setSettings({ ...state.settings, smtp_password: "" })}>
        <form onSubmit={saveEmailSettings}>
          <div className="dialog-heading">
            <div><p className="eyebrow">{t.ndKicker}</p><h2>{t.ndTitle}</h2></div>
            <button type="button" onClick={() => settingsDialog.current?.close()} aria-label={t.close}>×</button>
          </div>
          <label className="toggle-row">
            <span><strong>{t.ndDesktop}</strong><small>{t.ndDesktopNote}</small></span>
            <input type="checkbox" checked={settings.desktop_notifications} onChange={(e) => setSettings({ ...settings, desktop_notifications: e.target.checked })} />
          </label>
          <label className="toggle-row">
            <span><strong>{t.ndEmail}</strong><small>{t.ndEmailNote}</small></span>
            <input type="checkbox" checked={settings.email_enabled} onChange={(e) => setSettings({ ...settings, email_enabled: e.target.checked })} />
          </label>
          <div className={`email-fields ${!settings.email_enabled ? "fields-disabled" : ""}`}>
            <label><span>{t.ndTo}</span><input type="email" value={settings.email_to} onChange={(e) => setSettings({ ...settings, email_to: e.target.value })} disabled={!settings.email_enabled} /></label>
            <div className="field-pair">
              <label><span>{t.ndHost}</span><input value={settings.smtp_host} placeholder="smtp.gmail.com" onChange={(e) => setSettings({ ...settings, smtp_host: e.target.value })} disabled={!settings.email_enabled} /></label>
              <label><span>{t.ndPort}</span><input type="number" value={settings.smtp_port} onChange={(e) => setSettings({ ...settings, smtp_port: Number(e.target.value) })} disabled={!settings.email_enabled} /></label>
            </div>
            <label><span>{t.ndUser}</span><input value={settings.smtp_user} onChange={(e) => setSettings({ ...settings, smtp_user: e.target.value })} disabled={!settings.email_enabled} /></label>
            <label><span>{t.ndPassword} {settings.smtp_password_set && <small>{t.ndPasswordSaved}</small>}</span><input type="password" value={settings.smtp_password} onChange={(e) => setSettings({ ...settings, smtp_password: e.target.value })} disabled={!settings.email_enabled} /></label>
            <label><span>{t.ndFrom} <small>{t.ndFromNote}</small></span><input type="email" value={settings.smtp_from} onChange={(e) => setSettings({ ...settings, smtp_from: e.target.value })} disabled={!settings.email_enabled} /></label>
            <label className="inline-check"><input type="checkbox" checked={settings.smtp_ssl} onChange={(e) => setSettings({ ...settings, smtp_ssl: e.target.checked })} disabled={!settings.email_enabled} /> {t.ndSsl}</label>
          </div>
          <div className="dialog-actions">
            <button type="button" className="secondary-button" onClick={testEmail} disabled={!settings.email_enabled || busy === "test-email"}>{t.ndTest}</button>
            <button type="submit" className="primary-button" disabled={busy === "settings"}><span>{t.ndSave}</span><b>↗</b></button>
          </div>
        </form>
      </dialog>

      {message && <div className="toast" role="status">{message}</div>}
    </div>
  );
}

export default App;
