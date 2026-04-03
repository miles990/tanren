#!/bin/bash
# akari.sh — Standard start/stop/status for Akari
#
# Usage:
#   akari up        Start Akari (--serve mode, port 3002)
#   akari down      Stop Akari
#   akari restart   Restart
#   akari status    Check status
#   akari logs      Tail logs
#   akari install   Install launchd service (auto-start on boot)
#   akari uninstall Remove launchd service

set -euo pipefail

LABEL="com.tanren.akari"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/com.tanren.akari.plist"
AKARI_DIR="/Users/user/Workspace/akari"
LOG_DIR="$HOME/.tanren"
LOG_FILE="$LOG_DIR/akari.log"
ERR_FILE="$LOG_DIR/akari.error.log"
PORT="${AKARI_PORT:-3002}"

ensure_log_dir() {
  mkdir -p "$LOG_DIR"
}

find_pid() {
  lsof -i ":$PORT" -P -n -t 2>/dev/null | head -1
}

case "${1:-status}" in
  up|start)
    if pid=$(find_pid); then
      echo "Akari already running (PID $pid, port $PORT)"
      exit 0
    fi
    ensure_log_dir
    echo "Starting Akari on port $PORT..."
    cd "$AKARI_DIR"
    nohup npx tsx reference-run.ts --serve \
      > "$LOG_FILE" 2> "$ERR_FILE" &

    # Wait for startup
    for i in $(seq 1 10); do
      sleep 1
      if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
        pid=$(find_pid)
        echo "✅ Akari running (PID $pid, port $PORT)"
        exit 0
      fi
    done
    echo "❌ Akari failed to start. Check logs:"
    echo "  tail $LOG_FILE"
    echo "  tail $ERR_FILE"
    exit 1
    ;;

  down|stop)
    pid=$(find_pid)
    if [ -z "$pid" ]; then
      echo "Akari not running"
      exit 0
    fi
    echo "Stopping Akari (PID $pid)..."
    kill "$pid" 2>/dev/null
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null
    fi
    echo "✅ Akari stopped"
    ;;

  restart)
    "$0" down
    sleep 1
    "$0" up
    ;;

  status)
    pid=$(find_pid)
    if [ -z "$pid" ]; then
      echo "Akari: OFFLINE (port $PORT not listening)"
      exit 1
    fi
    health=$(curl -sf "http://localhost:$PORT/status" 2>/dev/null)
    if [ -n "$health" ]; then
      echo "Akari: ONLINE (PID $pid, port $PORT)"
      echo "$health" | python3 -m json.tool 2>/dev/null || echo "$health"
    else
      echo "Akari: DEGRADED (PID $pid, port $PORT, /status not responding)"
    fi
    ;;

  logs)
    tail -f "$LOG_FILE" 2>/dev/null
    ;;

  install)
    if [ ! -f "$PLIST_SRC" ]; then
      echo "❌ Plist not found: $PLIST_SRC"
      exit 1
    fi
    ensure_log_dir
    # Update plist to use --serve mode
    sed 's/--watch/--serve/' "$PLIST_SRC" > "$PLIST"
    launchctl load "$PLIST"
    echo "✅ Installed: $LABEL (auto-start on login)"
    ;;

  uninstall)
    if [ -f "$PLIST" ]; then
      launchctl unload "$PLIST" 2>/dev/null || true
      rm "$PLIST"
      echo "✅ Uninstalled: $LABEL"
    else
      echo "Not installed"
    fi
    ;;

  *)
    echo "Usage: akari {up|down|restart|status|logs|install|uninstall}"
    exit 1
    ;;
esac
