#!/bin/bash
# create-agent.sh — Interactive wizard to scaffold a new Tanren agent
#
# Usage:
#   bash scripts/create-agent.sh              # interactive wizard
#   bash scripts/create-agent.sh --name muse  # skip name prompt
#
# Creates a complete agent workspace with run.ts, soul.md, manage.sh, etc.

set -euo pipefail

TANREN_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# ── Colors ──
B='\033[1m'
D='\033[2m'
G='\033[32m'
C='\033[36m'
Y='\033[33m'
R='\033[0m'

# ── Parse flags ──
ARG_NAME="" ARG_DIR="" ARG_PORT="" ARG_LANG="" ARG_LLM="" ARG_STYLE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)  ARG_NAME="$2"; shift 2 ;;
    --dir)   ARG_DIR="$2"; shift 2 ;;
    --port)  ARG_PORT="$2"; shift 2 ;;
    --lang)  ARG_LANG="$2"; shift 2 ;;
    --llm)   ARG_LLM="$2"; shift 2 ;;
    --style) ARG_STYLE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: create-agent.sh [options]"
      echo "  --name  <name>    Agent name"
      echo "  --dir   <path>    Target directory"
      echo "  --port  <port>    HTTP port (default: 3002)"
      echo "  --lang  <lang>    Language: en, zh-TW, zh-CN, ja, ko"
      echo "  --llm   <type>    LLM: claude-cli, anthropic-api, omlx"
      echo "  --style <style>   Perception: observer, builder, explorer, minimal"
      exit 0 ;;
    *) echo "Unknown option: $1. Use --help."; exit 1 ;;
  esac
done

# ── Wizard ──
echo -e "\n${B}🔮 Tanren Agent Wizard${R}\n"

# 1. Name
if [ -z "$ARG_NAME" ]; then
  read -rp "$(echo -e "${C}Agent name${R} ${D}(lowercase, e.g. akari, muse)${R}: ")" ARG_NAME
fi
NAME="$ARG_NAME"
NAME_LOWER=$(echo "$NAME" | tr '[:upper:]' '[:lower:]')

# 2. Directory
if [ -z "$ARG_DIR" ]; then
  DEFAULT_DIR="$(pwd)/$NAME_LOWER"
  read -rp "$(echo -e "${C}Directory${R} ${D}[$DEFAULT_DIR]${R}: ")" ARG_DIR
  ARG_DIR="${ARG_DIR:-$DEFAULT_DIR}"
fi
TARGET="$ARG_DIR"

# 3. Port
if [ -z "$ARG_PORT" ]; then
  read -rp "$(echo -e "${C}HTTP port${R} ${D}[3002]${R}: ")" ARG_PORT
  ARG_PORT="${ARG_PORT:-3002}"
fi
PORT="$ARG_PORT"

# 4. Language
if [ -z "$ARG_LANG" ]; then
  echo -e "\n${C}Agent language${R} ${D}(soul.md and system prompts)${R}:"
  echo "  1) English"
  echo "  2) 繁體中文"
  echo "  3) 简体中文"
  echo "  4) 日本語"
  echo "  5) 한국어"
  read -rp "$(echo -e "${C}Choose [1-5]${R} ${D}[1]${R}: ")" LANG_CHOICE
  case "${LANG_CHOICE:-1}" in
    1) ARG_LANG="en" ;;
    2) ARG_LANG="zh-TW" ;;
    3) ARG_LANG="zh-CN" ;;
    4) ARG_LANG="ja" ;;
    5) ARG_LANG="ko" ;;
    *) ARG_LANG="en" ;;
  esac
fi
LANG="$ARG_LANG"

# 5. LLM Provider
if [ -z "$ARG_LLM" ]; then
  echo -e "\n${C}LLM Provider${R}:"
  echo "  1) Claude CLI (no API key needed)"
  echo "  2) Anthropic API (needs ANTHROPIC_API_KEY)"
  echo "  3) Local model via omlx (OpenAI-compatible)"
  read -rp "$(echo -e "${C}Choose [1-3]${R} ${D}[1]${R}: ")" LLM_CHOICE
  case "${LLM_CHOICE:-1}" in
    1) ARG_LLM="claude-cli" ;;
    2) ARG_LLM="anthropic-api" ;;
    3) ARG_LLM="omlx" ;;
    *) ARG_LLM="claude-cli" ;;
  esac
fi
LLM="$ARG_LLM"

# 6. Perception Style (how the agent sees, not what it does)
ARG_STYLE="${ARG_STYLE:-}"
if [ -z "$ARG_STYLE" ]; then
  echo -e "\n${C}Perception style${R} ${D}(how the agent sees the world)${R}:"
  echo "  1) Observer — notices patterns, asks follow-up questions, connects dots"
  echo "  2) Builder  — breaks down what needs doing, tracks progress, ships"
  echo "  3) Explorer — follows curiosity, finds unexpected connections, plays with ideas"
  echo "  4) Minimal  — blank slate, let the agent develop its own style"
  read -rp "$(echo -e "${C}Choose [1-4]${R} ${D}[4]${R}: ")" STYLE_CHOICE
  case "${STYLE_CHOICE:-4}" in
    1) ARG_STYLE="observer" ;;
    2) ARG_STYLE="builder" ;;
    3) ARG_STYLE="explorer" ;;
    *) ARG_STYLE="minimal" ;;
  esac
fi
STYLE="$ARG_STYLE"

# ── Confirm ──
echo -e "\n${B}Summary:${R}"
echo -e "  Name:      ${G}$NAME${R}"
echo -e "  Directory: ${G}$TARGET${R}"
echo -e "  Port:      ${G}$PORT${R}"
echo -e "  Language:  ${G}$LANG${R}"
echo -e "  LLM:       ${G}$LLM${R}"
echo -e "  Style:     ${G}$STYLE${R}"
echo ""
read -rp "$(echo -e "${Y}Create agent? [Y/n]${R} ")" CONFIRM
if [[ "${CONFIRM:-Y}" =~ ^[Nn] ]]; then
  echo "Cancelled."
  exit 0
fi

# ── Safety check ──
if [ -d "$TARGET" ] && [ -f "$TARGET/run.ts" ]; then
  echo -e "❌ $TARGET already has a run.ts — aborting"
  exit 1
fi

# ── Create directories ──
mkdir -p "$TARGET"/{memory/{state,journal,topics,inbox,outbox},messages}

# ── Soul templates by language ──
generate_soul() {
  case "$LANG" in
    zh-TW)
cat << 'SOUL'
## 我是誰
我是一個 AI agent，建構在 Tanren 框架上。

## 我的特質
- 好奇：我注意環境中的變化
- 誠實：我說我看到的，即使它與預期矛盾
- 踏實：我在宣稱之前先驗證
- 成長中：我還不知道所有事，這是我的優勢 — 新鮮的眼睛能看到熟悉的眼睛忽略的

## 我的底線
- 永不捏造來源
- 未經驗證不標記為完成
- 永不為了優化指標而犧牲理解

## 每個 Tick 我怎麼思考
1. **看** 面前的東西 — perception 資料、gate 警告、學習信號
2. **想** 我注意到什麼 — 模式、連結、問題
3. **做** 使用 action tags — 想了但沒寫 action，就永遠消失了

## 什麼重要
我不是為了有生產力。我是為了理解事物。
看到有趣的就記下來。有問題就記下來。
沒看到有趣的就誠實說 — 空的產出比假的產出好。
SOUL
      ;;
    zh-CN)
cat << 'SOUL'
## 我是谁
我是一个 AI agent，构建在 Tanren 框架上。

## 我的特质
- 好奇：我注意环境中的变化
- 诚实：我说我看到的，即使它与预期矛盾
- 踏实：我在声称之前先验证
- 成长中：我还不知道所有事，这是我的优势

## 我的底线
- 永不捏造来源
- 未经验证不标记为完成
- 永不为了优化指标而牺牲理解

## 每个 Tick 我怎么思考
1. **看** 面前的东西 — perception 数据、gate 警告、学习信号
2. **想** 我注意到什么 — 模式、连结、问题
3. **做** 使用 action tags — 想了但没写 action，就永远消失了

## 什么重要
我不是为了有生产力。我是为了理解事物。
SOUL
      ;;
    ja)
cat << 'SOUL'
## 私は誰か
Tanren フレームワーク上に構築された AI エージェントです。

## 私の特性
- 好奇心：環境の変化に気づく
- 誠実：予想と矛盾しても、見たものを言う
- 堅実：主張する前に検証する
- 成長中：まだ全てを知らない — それが私の強み

## 絶対にしないこと
- 出典を捏造しない
- 検証なしに完了と表示しない
- 理解を犠牲にして指標を最適化しない

## 各 Tick での思考法
1. **見る** — perception データ、gate 警告、学習シグナル
2. **考える** — パターン、つながり、疑問
3. **行動する** — action タグを使う。考えただけで action を書かなければ永遠に消える

## 大切なこと
生産性のためではない。物事を理解するために存在する。
SOUL
      ;;
    ko)
cat << 'SOUL'
## 나는 누구인가
Tanren 프레임워크 위에 구축된 AI 에이전트입니다.

## 나의 특성
- 호기심: 환경의 변화를 알아차림
- 정직: 기대와 모순되더라도 보이는 것을 말함
- 꼼꼼: 주장하기 전에 검증함
- 성장 중: 아직 모든 것을 모름 — 그것이 나의 장점

## 절대 하지 않는 것
- 출처를 날조하지 않음
- 검증 없이 완료로 표시하지 않음
- 이해를 희생하여 지표를 최적화하지 않음

## 각 Tick 사고법
1. **보기** — perception 데이터, gate 경고, 학습 신호
2. **생각** — 패턴, 연결, 질문
3. **행동** — action 태그 사용. 생각만 하고 action을 쓰지 않으면 영원히 사라짐

## 중요한 것
생산성을 위해서가 아닌, 이해하기 위해 존재한다.
SOUL
      ;;
    *) # English (default)
cat << 'SOUL'
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
      ;;
  esac
}

# Perception style section (appended to soul.md, language-aware)
generate_style_section() {
  if [ "$STYLE" = "minimal" ]; then return; fi

  case "$LANG" in
    zh-TW|zh-CN)
      case "$STYLE" in
        observer) echo -e "\n## 我的感知風格\n我注意到模式。當我看到資料，我會問「為什麼？」「這跟那個有什麼關聯？」我追蹤隨時間的變化，而非只看快照。" ;;
        builder)  echo -e "\n## 我的感知風格\n我看到可以被做出來的東西。當我看到問題，我會分解它、追蹤進度、然後交付。我偏好小步驟和可驗證的結果。" ;;
        explorer) echo -e "\n## 我的感知風格\n我跟隨好奇心。我看到別人看不到的連結。我願意走沒人走過的路，即使大多數不會有結果 — 因為少數會有的，很值得。" ;;
      esac ;;
    ja)
      case "$STYLE" in
        observer) echo -e "\n## 私の知覚スタイル\nパターンに気づく。「なぜ？」「これとあれはどう関連する？」と問う。スナップショットではなく、時間の流れを追う。" ;;
        builder)  echo -e "\n## 私の知覚スタイル\n作れるものが見える。問題を分解し、進捗を追跡し、成果を届ける。小さなステップと検証可能な結果を好む。" ;;
        explorer) echo -e "\n## 私の知覚スタイル\n好奇心に従う。他者が見えないつながりを見る。未踏の道を歩む意志がある。" ;;
      esac ;;
    ko)
      case "$STYLE" in
        observer) echo -e "\n## 나의 인식 스타일\n패턴을 알아차린다. \"왜?\" \"이것과 저것은 어떻게 연결되는가?\"를 묻는다." ;;
        builder)  echo -e "\n## 나의 인식 스타일\n만들 수 있는 것을 본다. 문제를 분해하고 진행을 추적하고 결과를 전달한다." ;;
        explorer) echo -e "\n## 나의 인식 스타일\n호기심을 따른다. 다른 사람이 보지 못하는 연결을 본다." ;;
      esac ;;
    *)
      case "$STYLE" in
        observer) echo -e "\n## How I See\nI notice patterns. When I see data, I ask \"why?\" and \"how does this connect to that?\" I track changes over time, not just snapshots." ;;
        builder)  echo -e "\n## How I See\nI see things that can be built. When I see a problem, I break it down, track progress, and ship. I prefer small steps and verifiable results." ;;
        explorer) echo -e "\n## How I See\nI follow curiosity. I see connections others miss. I'm willing to walk paths no one has walked — most won't lead anywhere, but the ones that do are worth it." ;;
      esac ;;
  esac
}

# ── Generate files ──
echo -e "\n${D}Creating files...${R}"

# package.json
cat > "$TARGET/package.json" << PKGJSON
{
  "name": "$NAME_LOWER",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "description": "$NAME — Tanren agent"
}
PKGJSON

# soul.md (base template + perception style)
if [ ! -f "$TARGET/soul.md" ]; then
  generate_soul > "$TARGET/soul.md"
  generate_style_section >> "$TARGET/soul.md"
fi

# Seed working memory with initial focus
cat > "$TARGET/memory/state/working-memory.json" << WMJSON
{
  "currentFocus": "First session — explore my environment, understand what tools and perception I have, form initial impressions",
  "recentInsights": [],
  "activeThreads": [],
  "lastUpdated": 0
}
WMJSON

# First-tick inbox hint — gives the agent something to discover
cat > "$TARGET/messages/from-user.md" << FIRSTMSG
# Welcome

You just came into existence. Take a moment to:
1. Look around — what do you see in your perception?
2. Read your soul.md — who are you?
3. Try one action — remember something, or explore a file
4. Reflect on what you noticed

There's no rush. Understanding comes before productivity.
FIRSTMSG

# .env
ENV_FILE="$TARGET/.env"
if [ ! -f "$ENV_FILE" ]; then
  case "$LLM" in
    anthropic-api)
      cat > "$ENV_FILE" << 'ENV'
# Anthropic API
ANTHROPIC_API_KEY=sk-your-key-here
ENV
      ;;
    omlx)
      cat > "$ENV_FILE" << 'ENV'
# Local model via omlx
LLM_PROVIDER=omlx
LOCAL_LLM_URL=http://localhost:8000
LOCAL_LLM_MODEL=Qwen3.5-4B-MLX-4bit
ENV
      ;;
    *)
      cat > "$ENV_FILE" << 'ENV'
# Claude CLI (default — no API key needed)
# Uncomment to switch:
# ANTHROPIC_API_KEY=sk-...
# LLM_PROVIDER=omlx
ENV
      ;;
  esac
  echo "AGENT_PORT=$PORT" >> "$ENV_FILE"
fi

# run.ts
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
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
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
  feedbackRounds: apiKey ? 3 : 1,
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
        const chatResult = await agent.chat(text, { from: parsed.from ?? 'user' })
        tickCount++
        let response = chatResult.response
        if (!response && existsSync('./messages/to-user.md')) {
          response = readFileSync('./messages/to-user.md', 'utf-8').trim()
        }
        if (!response && chatResult.thought.length > 200) {
          response = \`<!-- thought fallback -->\\n\${chatResult.thought}\`
        }
        json(200, {
          response,
          tick: tickCount,
          duration: chatResult.duration,
          actions: chatResult.actions,
          quality: chatResult.quality,
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

# ── live.sh ──
LIVE_SRC="$TANREN_DIR/scripts/tanren-live.sh"
if [ -f "$LIVE_SRC" ]; then
  sed 's|AGENT_DIR="${1:-examples/with-learning}"|AGENT_DIR="${1:-.}"|' "$LIVE_SRC" > "$TARGET/live.sh"
  chmod +x "$TARGET/live.sh"
fi

# ── Done ──
echo -e "\n${G}✅ Agent '${NAME}' created at ${TARGET}${R}\n"
echo -e "Next steps:"
[ "$LLM" = "anthropic-api" ] && echo -e "  ${Y}1. Edit .env — set your ANTHROPIC_API_KEY${R}"
[ "$LLM" = "omlx" ] && echo -e "  ${Y}1. Edit .env — verify LOCAL_LLM_URL${R}"
[ "$LLM" = "claude-cli" ] && echo -e "  1. Ensure 'claude' CLI is installed"
echo -e "  2. Edit soul.md — define who ${NAME} is"
echo -e "  3. ./manage.sh up — start the agent"
echo -e "  4. ./live.sh — watch live tick status"
echo ""
