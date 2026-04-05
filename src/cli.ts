#!/usr/bin/env node
/**
 * Tanren CLI — Run an agent from the command line
 *
 * Usage:
 *   tanren tick   [--config path]              Run a single tick
 *   tanren start  [--config path] [--interval ms]  Start the loop
 */

import { resolve, dirname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createAgent } from './index.js'
import type { TanrenConfig } from './types.js'

/** Load .env from cwd — framework responsibility, not each config's */
function loadEnv(): void {
  const envPath = resolve('.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.+?)\s*$/)
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  }
}

const args = process.argv.slice(2)
const command = args[0]

if (!command || command === '--help' || command === '-h') {
  console.log(`
tanren — Minimal AI agent framework

Commands:
  tick    Run a single perceive→think→act cycle
  run     Self-paced chain — agent decides when to stop
  chat    Interactive conversation with the agent
  start   Start the autonomous loop
  serve   Start HTTP server (POST /chat, GET /health, GET /status)
  health  Check a running agent's health
  status  Get a running agent's status

Options:
  --config <path>    Path to config file (default: ./tanren.config.ts)
  --interval <ms>    Tick interval in ms (default: 60000)
  --port <port>      HTTP port for serve/health/status (default: 3000)

Examples:
  npx tanren tick
  npx tanren serve --port 3002
  npx tanren health --port 3002
  npx tanren start --config ./my-agent/config.ts
`.trim())
  process.exit(0)
}

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`)
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1]
  }
  return undefined
}

async function loadConfig(): Promise<TanrenConfig> {
  const configPath = getFlag('config')

  // Try to import a config file
  if (configPath) {
    const abs = resolve(configPath)
    if (!existsSync(abs)) {
      console.error(`Config not found: ${abs}`)
      process.exit(1)
    }
    const mod = await import(abs)
    return mod.default ?? mod.config ?? mod
  }

  // Look for default config files
  const defaults = ['tanren.config.ts', 'tanren.config.js', 'tanren.config.mjs']
  for (const name of defaults) {
    const abs = resolve(name)
    if (existsSync(abs)) {
      const mod = await import(abs)
      return mod.default ?? mod.config ?? mod
    }
  }

  // Minimal fallback: look for soul.md in current directory
  const soulPath = resolve('soul.md')
  if (existsSync(soulPath)) {
    console.log('[tanren] No config found, using soul.md with defaults')
    return {
      identity: soulPath,
      memoryDir: './memory',
    }
  }

  console.error('No config found. Create tanren.config.ts or soul.md')
  process.exit(1)
}

async function main(): Promise<void> {
  loadEnv()
  const config = await loadConfig()
  const interval = getFlag('interval')

  const agent = createAgent(config)

  if (command === 'tick') {
    console.log('[tanren] Running one tick...')
    try {
      const result = await agent.tick()
      console.log(`[tanren] Tick completed in ${result.observation.duration}ms`)
      console.log(`  Actions: ${result.actions.map(a => a.type).join(', ') || '(none)'}`)
      console.log(`  Gates: ${result.gateResults.filter(g => g.action !== 'pass').length} triggered`)
      if (result.observation.environmentFeedback) {
        console.log(`  Feedback: ${result.observation.environmentFeedback.slice(0, 200)}`)
      }
      console.log()
      console.log('--- Thought ---')
      console.log(result.thought)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[tanren] Tick failed: ${msg}`)
      process.exit(1)
    }
  } else if (command === 'run') {
    const message = args.slice(1).join(' ') || undefined
    console.log(`[tanren] Self-paced chain${message ? `: "${message}"` : ''}`)
    console.log('[tanren] Agent decides when to stop. Gates enforce honesty.\n')
    try {
      const results = await agent.runChain(message)
      console.log(`\n[tanren] Chain completed: ${results.length} tick(s)`)
      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        const acts = r.actions.map(a => a.type).join(', ') || '(none)'
        console.log(`  Tick ${i + 1}: ${acts} (${Math.round(r.observation.duration / 1000)}s, quality: ${r.observation.outputQuality}/5)`)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[tanren] Chain failed: ${msg}`)
      process.exit(1)
    }
  } else if (command === 'chat') {
    const { createInterface } = await import('node:readline')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log('[tanren] Chat mode (streaming) — type your message, Enter to send, Ctrl+C to quit\n')

    // Try Agent SDK streaming first, fallback to non-streaming agent.chat()
    let useAgentSdk = false
    try {
      await import('@anthropic-ai/claude-agent-sdk')
      useAgentSdk = true
    } catch { /* Agent SDK not installed — fallback */ }

    const prompt = (): void => {
      rl.question('\x1b[36mYou>\x1b[0m ', async (input) => {
        const trimmed = input.trim()
        if (!trimmed) { prompt(); return }

        const start = Date.now()

        if (useAgentSdk) {
          // Streaming mode — show thinking + tool calls in real-time
          try {
            const { query } = await import('@anthropic-ai/claude-agent-sdk')
            process.stdout.write('\x1b[2m⏳ thinking...\x1b[0m')
            let result = ''
            let toolCount = 0

            for await (const message of query({
              prompt: trimmed,
              options: {
                cwd: process.cwd(),
                allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
                maxTurns: 15,
                permissionMode: 'bypassPermissions',
                allowDangerouslySkipPermissions: true,
              },
            })) {
              if ('result' in message) {
                result = (message as { result: string }).result
              } else if (message.type === 'system') {
                const sub = (message as Record<string, unknown>).subtype as string ?? ''
                if (sub === 'tool_use' || sub === 'task_started') {
                  toolCount++
                  const name = (message as Record<string, unknown>).tool_name ?? (message as Record<string, unknown>).name ?? 'tool'
                  process.stdout.write(`\r\x1b[2m⚡ ${name} \x1b[33m(${toolCount} tools)\x1b[0m   `)
                } else if (sub === 'task_progress') {
                  const summary = (message as Record<string, unknown>).summary as string ?? ''
                  if (summary) process.stdout.write(`\r\x1b[2m📊 ${summary.slice(0, 60)}\x1b[0m   `)
                }
              }
            }

            // Clear progress line
            process.stdout.write('\r\x1b[K')
            const elapsed = ((Date.now() - start) / 1000).toFixed(1)

            if (result) {
              console.log(`\x1b[32mAgent>\x1b[0m (${elapsed}s, ${toolCount} tools)\n`)
              console.log(result)
            } else {
              console.log(`\x1b[33mAgent>\x1b[0m (${elapsed}s, no result)`)
            }
          } catch (err: unknown) {
            process.stdout.write('\x1b[0m\n')
            const msg = err instanceof Error ? err.message : String(err)
            console.error(`\x1b[31m[error]\x1b[0m ${msg}`)
          }
        } else {
          // Non-streaming fallback
          try {
            const result = await agent.chat(trimmed)
            const elapsed = ((Date.now() - start) / 1000).toFixed(1)
            const actionsStr = result.actions.join(', ') || 'none'

            if (result.response) {
              console.log(`\x1b[32mAgent>\x1b[0m (${elapsed}s, actions: ${actionsStr})\n`)
              console.log(result.response)
            } else {
              console.log(`\x1b[33mAgent (thought only)>\x1b[0m (${elapsed}s)\n`)
              console.log(result.thought.slice(0, 2000))
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error(`\x1b[31m[error]\x1b[0m ${msg}`)
          }
        }
        console.log()
        prompt()
      })
    }
    prompt()

    const shutdown = () => { rl.close(); console.log('\n[tanren] Bye'); process.exit(0) }
    process.on('SIGINT', shutdown)
  } else if (command === 'serve') {
    const port = interval ? parseInt(interval, 10) : (getFlag('port') ? parseInt(getFlag('port')!, 10) : 3000)
    const { serve } = await import('./serve.js')
    const name = config.identity?.toString().split('/').pop()?.replace('.md', '') ?? 'tanren-agent'
    serve(agent, { port, serviceName: name, memoryDir: config.memoryDir })

  } else if (command === 'health') {
    const port = getFlag('port') ?? '3000'
    try {
      const res = await fetch(`http://localhost:${port}/health`)
      console.log(JSON.stringify(await res.json(), null, 2))
    } catch { console.error(`No agent on port ${port}`); process.exit(1) }

  } else if (command === 'status') {
    const port = getFlag('port') ?? '3000'
    try {
      const res = await fetch(`http://localhost:${port}/status`)
      console.log(JSON.stringify(await res.json(), null, 2))
    } catch { console.error(`No agent on port ${port}`); process.exit(1) }

  } else if (command === 'start') {
    const ms = interval ? parseInt(interval, 10) : (config.tickInterval ?? 60_000)
    console.log(`[tanren] Starting loop (interval: ${ms}ms)`)
    console.log('[tanren] Press Ctrl+C to stop')

    agent.start(ms)

    // Handle graceful shutdown
    const shutdown = () => {
      console.log('\n[tanren] Stopping...')
      agent.stop()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  } else {
    console.error(`Unknown command: ${command}`)
    console.error('Use "tanren tick", "tanren chat", or "tanren start"')
    process.exit(1)
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`[tanren] Fatal: ${msg}`)
  process.exit(1)
})
