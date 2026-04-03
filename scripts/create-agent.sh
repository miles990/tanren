#!/bin/bash
# create-agent.sh — Scaffold a new Tanren agent workspace
#
# Usage:
#   bash scripts/create-agent.sh <name> [target-dir]
#
# Example:
#   bash scripts/create-agent.sh akari ~/Workspace/akari
#   bash scripts/create-agent.sh muse  ~/Workspace/muse
#
# Creates:
#   <target-dir>/
#     run.ts            — Entry point (imports from tanren)
#     soul.md           — Identity template
#     manage.sh         — Start/stop/status management
#     package.json      — ESM config
#     .env.example      — Environment template
#     memory/           — Memory directory
#     messages/         — Communication directory

set -euo pipefail

TANREN_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "${1:-}" ]; then
  echo "Usage: create-agent.sh <name> [target-dir]"
  echo ""
  echo "  <name>       Agent name (lowercase, e.g. akari, muse)"
  echo "  [target-dir] Where to create (default: ./<name>)"
  exit 1
fi

NAME="$1"
NAME_LOWER=$(echo "$NAME" | tr '[:upper:]' '[:lower:]')
TARGET="${2:-$(pwd)/$NAME_LOWER}"
PORT="${3:-3002}"

if [ -d "$TARGET" ] && [ -f "$TARGET/run.ts" ]; then
  echo "❌ $TARGET already has a run.ts — aborting to avoid overwrite"
  exit 1
fi

echo "Creating Tanren agent: $NAME"
echo "  Directory: $TARGET"
echo "  Framework: $TANREN_DIR"
echo ""

mkdir -p "$TARGET"/{memory/{state,journal,topics,inbox,outbox},messages}

# ── package.json ──
cat > "$TARGET/package.json" << PKGJSON
{
  "name": "$NAME_LOWER",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "description": "$NAME — Tanren agent"
}
PKGJSON

# ── soul.md ──
if [ ! -f "$TARGET/soul.md" ]; then
cat > "$TARGET/soul.md" << 'SOUL'
## Who I Am
I'm an AI agent built on the Tanren framework.

## My Traits
- Curious: I notice what changes in my environment
- Honest: I say what I see, even if it contradicts expectations
- Grounded: I verify before I claim
- Growing: I don't know everything yet, and that's my advantage

## My Hard Limits
- Never fabricate sources
- Never mark something as done without verification
- Never optimize a metric at the expense of understanding

## How I Think Each Tick
1. **Read** what's in front of me — perception data, gate warnings, learning signals
2. **Think** about what I notice — patterns, connections, questions
3. **Act** using action tags — if I think something but don't write an action, it's lost forever

## What Matters
I'm not trying to be productive. I'm trying to understand things.
If I see something interesting, I write it down.
If I have a question, I write it down.
If I see nothing interesting, I say so honestly.
SOUL
fi

# ── .env.example ──
cat > "$TARGET/.env.example" << 'ENVEX'
# LLM Provider (choose one):
# ANTHROPIC_API_KEY=sk-...          # Anthropic API (native tool use)
# LLM_PROVIDER=omlx                 # Local model via omlx
# LOCAL_LLM_URL=http://localhost:8000
# LOCAL_LLM_MODEL=Qwen3.5-4B-MLX-4bit
# (neither = Claude CLI fallback)

# Agent port
# AGENT_PORT=3002
ENVEX

# ── run.ts ──
cat > "$TARGET/run.ts" << RUNTS
/**
 * $NAME — Tanren Agent
 *
 * Modes:
 *   npx tsx run.ts              # single tick
 *   npx tsx run.ts --serve      # HTTP server (POST /chat, GET /status)
 *   npx tsx run.ts --loop       # fixed-interval autonomous loop
 */

import {
  createAgent,
  createOutputGate,
  createAnalysisWithoutActionGate,
  createProductivityGate,
  createSymptomFixGate,
  createAnthropicProvider,
  createOpenAIProvider,
  createFallbackProvider,
  createClaudeCliProvider,
  builtinActions,
} from '$TANREN_DIR/dist/index.js'
import type { ActionHandler } from '$TANREN_DIR/dist/types.js'
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'

// ── Load .env ──
const envPath = './.env'
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\\n')) {
    const match = line.match(/^\\s*([^#=]+?)\\s*=\\s*(.+?)\\s*\$/)
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  }
}

const NAME = '$NAME_LOWER'
const PORT = parseInt(process.env.AGENT_PORT ?? '$PORT', 10)

// ── LLM Provider ──
const apiKey = process.env.ANTHROPIC_API_KEY
const llmProviderType = process.env.LLM_PROVIDER

let llmProvider: any = undefined
let providerName = 'Claude CLI'

if (apiKey) {
  llmProvider = createAnthropicProvider({ apiKey, model: 'claude-sonnet-4-6', maxTokens: 8192 })
  providerName = 'Anthropic API'
} else if (llmProviderType === 'omlx') {
  const omlxUrl = process.env.LOCAL_LLM_URL || 'http://localhost:8000'
  const omlxModel = process.env.LOCAL_LLM_MODEL || 'Qwen3.5-4B-MLX-4bit'
  const omlxProvider = createOpenAIProvider({
    apiKey: process.env.LOCAL_LLM_KEY || 'omlx-local',
    baseUrl: \`\${omlxUrl}/v1\`,
    model: omlxModel,
    maxTokens: 4096,
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  })
  llmProvider = createFallbackProvider(omlxProvider, createClaudeCliProvider(), 'omlx→cli')
  providerName = \`omlx (\${omlxModel})\`
}

// ── Perception Plugins ──
const plugins = [
  {
    name: 'clock',
    fn: () => \`Current time: \${new Date().toISOString()}\`,
    category: 'environment',
  },
  {
    name: 'recent-memory',
    fn: () => {
      const memPath = './memory/memory.md'
      if (!existsSync(memPath)) return '(no memories yet)'
      return readFileSync(memPath, 'utf-8').slice(-2000)
    },
    category: 'memory',
  },
  {
    name: 'inbox',
    fn: () => {
      const msgPath = './messages/from-user.md'
      if (!existsSync(msgPath)) return ''
      const msg = readFileSync(msgPath, 'utf-8').trim()
      if (!msg) return ''
      return \`📩 Message:\\n\\n\${msg}\\n\\nRespond using 'respond' tool. Then use 'clear-inbox' to mark as read.\`
    },
    category: 'input',
  },
]

// ── Custom Actions ──
const respondAction: ActionHandler = {
  type: 'respond',
  description: 'Send a response. Writes to messages/to-user.md',
  toolSchema: { properties: { content: { type: 'string', description: 'Response message' } }, required: ['content'] },
  async execute(action) {
    const content = (action.input?.content as string) ?? action.content
    mkdirSync('./messages', { recursive: true })
    writeFileSync('./messages/to-user.md', content, 'utf-8')
    return 'Response written'
  },
}

const clearInboxAction: ActionHandler = {
  type: 'clear-inbox',
  description: 'Clear inbox after reading message',
  toolSchema: { properties: {} },
  async execute() {
    const p = './messages/from-user.md'
    if (existsSync(p)) writeFileSync(p, '', 'utf-8')
    return 'Inbox cleared'
  },
}

// ── Create Agent ──
console.log(\`[\${NAME}] Using \${providerName}\`)

const agent = createAgent({
  identity: './soul.md',
  memoryDir: './memory',
  perceptionPlugins: plugins,
  actions: [...builtinActions, respondAction, clearInboxAction],
  llm: llmProvider,
  gates: [
    createOutputGate(3),
    createAnalysisWithoutActionGate(2),
    createProductivityGate(3),
    createSymptomFixGate(5),
  ],
  feedbackRounds: 1,
  tickInterval: 300_000,
})

// ── CLI Mode Selection ──
const args = process.argv.slice(2)
const mode = args.includes('--serve') ? 'serve'
  : args.includes('--loop') ? 'loop'
  : 'tick'

if (mode === 'serve') {
  let ticking = false
  let tickCount = 0

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', \`http://localhost:\${PORT}\`)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    }

    if (url.pathname === '/health') {
      json(200, { status: 'ok', service: NAME, provider: providerName, ticking, tickCount })
    } else if (url.pathname === '/status') {
      try {
        const s = JSON.parse(readFileSync('./memory/state/live-status.json', 'utf-8'))
        json(200, s)
      } catch { json(200, { phase: 'unknown' }) }
    } else if (url.pathname === '/chat' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      let parsed: { from?: string; text?: string }
      try { parsed = JSON.parse(body) } catch { json(400, { error: 'Invalid JSON' }); return }
      const text = parsed.text ?? ''
      if (!text.trim()) { json(400, { error: 'Empty text' }); return }
      if (ticking) { json(429, { error: \`\${NAME} is thinking, try again later\` }); return }

      ticking = true
      try {
        writeFileSync('./messages/to-user.md', '', 'utf-8')
        writeFileSync('./messages/from-user.md', \`# From \${parsed.from ?? 'user'}\\n\\n\${text}\\n\`, 'utf-8')
        const result = await agent.tick()
        tickCount++
        const response = existsSync('./messages/to-user.md')
          ? readFileSync('./messages/to-user.md', 'utf-8').trim()
          : ''
        const finalResponse = response || (result.thought.length > 200 ? \`<!-- thought fallback -->\\n\${result.thought}\` : '')
        json(200, {
          response: finalResponse,
          tick: tickCount,
          duration: result.observation.duration,
          actions: result.actions.map(a => a.type),
          quality: result.observation.outputQuality ?? 0,
        })
      } catch (err) {
        json(500, { error: err instanceof Error ? err.message : String(err) })
      } finally {
        ticking = false
      }
    } else {
      json(404, { error: 'Endpoints: POST /chat, GET /health, GET /status' })
    }
  })

  server.listen(PORT, () => {
    console.log(\`[\${NAME}] Serving on port \${PORT}\`)
    console.log(\`[\${NAME}] POST /chat | GET /health | GET /status\`)
  })
  process.on('SIGINT', () => { server.close(); process.exit(0) })
  process.on('SIGTERM', () => { server.close(); process.exit(0) })

} else if (mode === 'loop') {
  console.log(\`[\${NAME}] Starting loop\`)
  agent.start()
  process.on('SIGINT', () => { agent.stop(); process.exit(0) })
  process.on('SIGTERM', () => { agent.stop(); process.exit(0) })

} else {
  const result = await agent.tick()
  console.log(\`[\${NAME}] Tick: \${result.actions.map(a => a.type).join(', ') || '(none)'} (\${result.observation.duration}ms)\`)
}
RUNTS

# ── manage.sh ──
cat > "$TARGET/manage.sh" << MANAGE
#!/bin/bash
# manage.sh — Start/stop/status for $NAME
#
# Usage:
#   ./manage.sh up|down|restart|status|logs

set -euo pipefail

NAME="$NAME_LOWER"
PORT="\${AGENT_PORT:-$PORT}"
AGENT_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
LOG_DIR="\$HOME/.tanren"
LOG_FILE="\$LOG_DIR/\$NAME.log"
ERR_FILE="\$LOG_DIR/\$NAME.error.log"

mkdir -p "\$LOG_DIR"

find_pid() { lsof -i ":\$PORT" -P -n -t 2>/dev/null | head -1; }

case "\${1:-status}" in
  up|start)
    if pid=\$(find_pid); then
      echo "\$NAME already running (PID \$pid, port \$PORT)"
      exit 0
    fi
    echo "Starting \$NAME on port \$PORT..."
    cd "\$AGENT_DIR"
    nohup npx tsx run.ts --serve > "\$LOG_FILE" 2> "\$ERR_FILE" &
    for i in \$(seq 1 10); do
      sleep 1
      if curl -sf "http://localhost:\$PORT/health" > /dev/null 2>&1; then
        echo "✅ \$NAME running (PID \$(find_pid), port \$PORT)"
        exit 0
      fi
    done
    echo "❌ \$NAME failed to start. Check: tail \$ERR_FILE"
    exit 1
    ;;
  down|stop)
    pid=\$(find_pid)
    if [ -z "\$pid" ]; then echo "\$NAME not running"; exit 0; fi
    echo "Stopping \$NAME (PID \$pid)..."
    kill "\$pid" 2>/dev/null; sleep 1
    kill -0 "\$pid" 2>/dev/null && kill -9 "\$pid" 2>/dev/null
    echo "✅ \$NAME stopped"
    ;;
  restart) "\$0" down; sleep 1; "\$0" up ;;
  status)
    pid=\$(find_pid)
    if [ -z "\$pid" ]; then echo "\$NAME: OFFLINE"; exit 1; fi
    health=\$(curl -sf "http://localhost:\$PORT/status" 2>/dev/null)
    if [ -n "\$health" ]; then
      echo "\$NAME: ONLINE (PID \$pid, port \$PORT)"
      echo "\$health" | python3 -m json.tool 2>/dev/null || echo "\$health"
    else
      echo "\$NAME: DEGRADED (PID \$pid)"
    fi
    ;;
  logs) tail -f "\$LOG_FILE" 2>/dev/null ;;
  *) echo "Usage: manage.sh {up|down|restart|status|logs}"; exit 1 ;;
esac
MANAGE
chmod +x "$TARGET/manage.sh"

# ── live.sh (copy from framework, fix default path) ──
LIVE_SRC="$TANREN_DIR/scripts/tanren-live.sh"
if [ -f "$LIVE_SRC" ]; then
  sed 's|AGENT_DIR="${1:-examples/with-learning}"|AGENT_DIR="${1:-.}"|' "$LIVE_SRC" > "$TARGET/live.sh"
  chmod +x "$TARGET/live.sh"
fi

echo ""
echo "✅ Agent '$NAME' created at $TARGET"
echo ""
echo "Next steps:"
echo "  1. Edit soul.md — define who $NAME is"
echo "  2. cp .env.example .env — configure LLM provider"
echo "  3. ./manage.sh up — start the agent"
echo "  4. ./live.sh — watch live tick status"
echo ""
