#!/bin/bash
set -euo pipefail

PAGEWATCH_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PAGEWATCH_UI_URL="${PAGEWATCH_UI_URL:-}"
PAGEWATCH_EXPECTED_VERSION="$(
  /usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])' \
    "$PAGEWATCH_DIR/package.json"
)"
PAGEWATCH_BUILD_VERSION_FILE="$PAGEWATCH_DIR/dist/.pagewatch-version"
cd "$PAGEWATCH_DIR"

# The Pages UI (PAGEWATCH_UI_URL) only needs the Python API below, which uses
# no external packages. Building the bundled local UI is a bonus for people who
# open http://127.0.0.1:8765 directly, so only do it when npm is available.
PAGEWATCH_BUILT_VERSION=""
if [[ -f "$PAGEWATCH_BUILD_VERSION_FILE" ]]; then
  PAGEWATCH_BUILT_VERSION="$(<"$PAGEWATCH_BUILD_VERSION_FILE")"
fi
if [[ ! -f "$PAGEWATCH_DIR/dist/index.html" || "$PAGEWATCH_BUILT_VERSION" != "$PAGEWATCH_EXPECTED_VERSION" ]] \
  && command -v npm >/dev/null 2>&1; then
  echo "v${PAGEWATCH_EXPECTED_VERSION} の画面を準備しています…"
  if npm install && npm run build; then
    /usr/bin/printf '%s\n' "$PAGEWATCH_EXPECTED_VERSION" >"$PAGEWATCH_BUILD_VERSION_FILE"
    PAGEWATCH_BUILT_VERSION="$PAGEWATCH_EXPECTED_VERSION"
  else
    echo "ビルドはスキップしました。Web画面から操作できます。"
  fi
fi

if [[ -z "$PAGEWATCH_UI_URL" ]]; then
  if [[ -f "$PAGEWATCH_DIR/dist/index.html" && "$PAGEWATCH_BUILT_VERSION" == "$PAGEWATCH_EXPECTED_VERSION" ]]; then
    PAGEWATCH_UI_URL="http://127.0.0.1:8765/"
  else
    PAGEWATCH_UI_URL="https://t-shiokawa1.github.io/Page-Watch/"
  fi
fi

PAGEWATCH_HEALTH="$(
  /usr/bin/curl --fail --silent --max-time 1 "http://127.0.0.1:8765/api/health" 2>/dev/null || true
)"
if [[ -n "$PAGEWATCH_HEALTH" ]]; then
  PAGEWATCH_RUNNING_VERSION="$(
    /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("version", ""))' \
      <<<"$PAGEWATCH_HEALTH" 2>/dev/null || true
  )"
  if [[ "$PAGEWATCH_RUNNING_VERSION" == "$PAGEWATCH_EXPECTED_VERSION" ]]; then
    echo "PageWatch v${PAGEWATCH_RUNNING_VERSION} はすでに起動しています。"
    open "$PAGEWATCH_UI_URL"
    exit 0
  fi

  echo "古いPageWatchを停止して v${PAGEWATCH_EXPECTED_VERSION} に更新しています…"
  PAGEWATCH_LISTENERS="$(/usr/sbin/lsof -nP -tiTCP:8765 -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$PAGEWATCH_LISTENERS" ]]; then
    kill $PAGEWATCH_LISTENERS
  fi

  # A launch agent may immediately restart the server from the updated files.
  # Reuse it if the expected version comes back; otherwise start it below.
  for _ in {1..20}; do
    sleep 0.25
    PAGEWATCH_HEALTH="$(
      /usr/bin/curl --fail --silent --max-time 1 "http://127.0.0.1:8765/api/health" 2>/dev/null || true
    )"
    if [[ -z "$PAGEWATCH_HEALTH" ]]; then
      continue
    fi
    PAGEWATCH_RUNNING_VERSION="$(
      /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("version", ""))' \
        <<<"$PAGEWATCH_HEALTH" 2>/dev/null || true
    )"
    if [[ "$PAGEWATCH_RUNNING_VERSION" == "$PAGEWATCH_EXPECTED_VERSION" ]]; then
      echo "PageWatch v${PAGEWATCH_RUNNING_VERSION} を起動しました。"
      open "$PAGEWATCH_UI_URL"
      exit 0
    fi
  done
fi

echo "PageWatch v${PAGEWATCH_EXPECTED_VERSION} を起動しています。このウィンドウは開いたままにしてください。"
exec /usr/bin/python3 "$PAGEWATCH_DIR/server.py" --open --open-url "$PAGEWATCH_UI_URL"
