#!/usr/bin/env bash
set -Eeuo pipefail

cd /work
export DISPLAY="${DISPLAY:-:99}"

mkdir -p tests-scripts .studio test-results playwright-report .runtime

# Install dependencies automatically on first start (the named volume starts empty).
if [[ ! -f node_modules/playwright/cli.js || ! -f node_modules/@playwright/test/cli.js ]]; then
  echo "[startup] Installing project dependencies..."
  npm install --no-audit --no-fund
fi

INSTALLED_VERSION="$(node -p "require('./node_modules/@playwright/test/package.json').version")"
if [[ "$INSTALLED_VERSION" != "$PLAYWRIGHT_VERSION" ]]; then
  echo "[startup] Version mismatch: package=$INSTALLED_VERSION image=$PLAYWRIGHT_VERSION"
  echo "[startup] Installing the matching Playwright Test version..."
  npm install --save-dev --no-audit --no-fund "@playwright/test@${PLAYWRIGHT_VERSION}"
fi

# Virtual desktop for headed Chromium and the Playwright Inspector.
DISPLAY_NUMBER="${DISPLAY#:}"
DISPLAY_NUMBER="${DISPLAY_NUMBER%%.*}"
X_LOCK="/tmp/.X${DISPLAY_NUMBER}-lock"
if [[ -f "$X_LOCK" ]]; then
  X_PID="$(tr -d '[:space:]' < "$X_LOCK")"
  if [[ "$X_PID" =~ ^[0-9]+$ ]] && ! kill -0 "$X_PID" 2>/dev/null; then
    rm -f "$X_LOCK" "/tmp/.X11-unix/X${DISPLAY_NUMBER}"
  fi
fi
Xvfb "$DISPLAY" -screen 0 1600x1000x24 -ac +extension RANDR -nolisten tcp \
  >.runtime/xvfb.log 2>&1 &
XVFB_PID=$!

for _ in $(seq 1 50); do
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
  sleep 0.2
done

if ! kill -0 "$XVFB_PID" 2>/dev/null || ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  echo "[startup] Xvfb failed to start; see .runtime/xvfb.log"
  exit 1
fi

fluxbox -display "$DISPLAY" >.runtime/fluxbox.log 2>&1 &
FLUXBOX_PID=$!

x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5900 -listen 127.0.0.1 \
  >.runtime/x11vnc.log 2>&1 &
VNC_PID=$!

websockify --web=/usr/share/novnc "${NOVNC_PORT:-6080}" 127.0.0.1:5900 \
  >.runtime/novnc.log 2>&1 &
NOVNC_PID=$!

cleanup() {
  echo "[shutdown] Stopping Playwright Studio..."
  if [[ -n "${MANAGER_PID:-}" ]]; then
    kill -TERM "$MANAGER_PID" 2>/dev/null || true
    wait "$MANAGER_PID" 2>/dev/null || true
  fi
  kill -TERM "$NOVNC_PID" "$VNC_PID" "$FLUXBOX_PID" "$XVFB_PID" 2>/dev/null || true
  wait "$NOVNC_PID" "$VNC_PID" "$FLUXBOX_PID" "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Manager supervises test script sessions and the Playwright UI service.
node manager/server.js &
MANAGER_PID=$!
wait "$MANAGER_PID"
