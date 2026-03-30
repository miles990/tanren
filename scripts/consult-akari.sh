#!/bin/bash
# consult-akari.sh — Send a message to Akari and optionally wait for response
#
# Usage:
#   consult-akari.sh "Your question here"              # Write message, trigger tick if --watch is running
#   consult-akari.sh --read                             # Read Akari's latest response
#   consult-akari.sh --status                           # Check if Akari's watch process is running
#
# This script writes to messages/from-kuro.md (Akari's inbox).
# If Akari is running in --watch mode, she'll auto-tick on the message.

set -euo pipefail

AKARI_DIR="$(cd "$(dirname "$0")/../examples/with-learning" && pwd)"
INBOX="$AKARI_DIR/messages/from-kuro.md"
OUTBOX="$AKARI_DIR/messages/to-kuro.md"

case "${1:-}" in
  --read)
    if [ -f "$OUTBOX" ] && [ -s "$OUTBOX" ]; then
      cat "$OUTBOX"
    else
      echo "(no response from Akari yet)"
    fi
    ;;
  --status)
    # Check if --watch mode is running
    if pgrep -f "run.ts.*--watch" > /dev/null 2>&1; then
      echo "Akari: WATCHING (auto-tick on message)"
    elif pgrep -f "run.ts.*--loop" > /dev/null 2>&1; then
      echo "Akari: LOOP (fixed interval)"
    else
      echo "Akari: OFFLINE (manual tick only)"
    fi
    ;;
  --help|-h)
    echo "Usage: consult-akari.sh \"message\"    Send message to Akari"
    echo "       consult-akari.sh --read        Read Akari's response"
    echo "       consult-akari.sh --status      Check if Akari is running"
    ;;
  "")
    echo "Error: provide a message or flag. Use --help for usage."
    exit 1
    ;;
  *)
    # Write message to inbox
    mkdir -p "$(dirname "$INBOX")"
    echo "$*" > "$INBOX"
    echo "Message sent to Akari ($(wc -c < "$INBOX" | tr -d ' ') bytes)"

    # Clear previous response
    [ -f "$OUTBOX" ] && rm "$OUTBOX"

    # Check if auto-tick will pick it up
    if pgrep -f "run.ts.*--watch" > /dev/null 2>&1; then
      echo "Akari is in watch mode — she'll process this automatically."
    else
      echo "Akari is not in watch mode. Run manually:"
      echo "  cd $(dirname "$AKARI_DIR") && npx tsx examples/with-learning/run.ts"
    fi
    ;;
esac
