import { createInterface } from 'node:readline'
import { statSync, watchFile } from 'node:fs'
import { join } from 'node:path'
import type { TanrenAgent } from './index.js'
import { serve, type ServeOptions } from './serve.js'
import type { PeerBridge } from './peer-bridge.js'
import type { TanrenConfig } from './types.js'
import { readScopedEnv, type ProviderSelection } from './provider-registry.js'
import { decideProviderUse, type ProviderPolicy } from './provider-policy.js'

export interface RuntimeCliOptions {
  agent: TanrenAgent
  agentConfig: TanrenConfig
  peerBridge: PeerBridge
  serviceName: string
  memoryDir: string
  messagesDir?: string
  providerName?: string
  providerSelection?: Pick<ProviderSelection, 'providerKey' | 'cloud'>
  providerPolicy?: ProviderPolicy
  env?: NodeJS.ProcessEnv
  serviceEnvPrefix?: string
  port?: number
  args?: string[]
  serveOptions?: Partial<ServeOptions>
  health?: () => Record<string, unknown>
}

export async function runAgentCli(opts: RuntimeCliOptions): Promise<void> {
  const args = opts.args ?? process.argv.slice(2)
  const env = opts.env ?? process.env
  const serviceEnvPrefix = opts.serviceEnvPrefix ?? opts.serviceName
  const mode = args.includes('--serve') ? 'serve'
    : args.includes('--chat') ? 'chat'
    : args.includes('--loop') ? 'loop'
    : args.includes('--watch') ? 'watch'
    : 'tick'
  const messagesDir = opts.messagesDir ?? './messages'

  async function runSingleTick(): Promise<void> {
    console.log(`[${opts.serviceName}] Running one tick...`)
    const result = await opts.agent.tick()
    console.log(`[${opts.serviceName}] Tick completed.`)
    console.log(`  Actions: ${result.actions.map(a => a.type).join(', ') || '(none)'}`)
    console.log(`  Duration: ${result.observation.duration}ms`)
    console.log(`  Gates: ${result.gateResults.length} triggered`)
    if (opts.peerBridge.applyWriteBackFallback(result)) console.log('  Write-back fallback: saved thought to peer outbox')
    console.log('\n--- Thought ---')
    console.log(result.thought.slice(0, 500))
  }

  if (mode === 'serve') {
    const port = opts.port ?? parseInt(readScopedEnv(env, 'PORT', serviceEnvPrefix) ?? env.AGENT_PORT ?? env.PORT ?? '3000', 10)
    const autonomous = args.includes('--autonomous') || readScopedEnv(env, 'AUTONOMOUS', serviceEnvPrefix) === '1'
    let tickCount = 0
    const handle = serve(opts.agent, {
      port,
      serviceName: opts.serviceName,
      memoryDir: opts.memoryDir,
      agentConfig: opts.agentConfig,
      onBeforeChat: async (from, text) => opts.peerBridge.onBeforeChat(from, text),
      onAfterChat: async () => { tickCount++ },
      health: opts.health,
      ...opts.serveOptions,
    })
    console.log(`[${opts.serviceName}] Provider: ${opts.providerName ?? 'unknown'}`)

    const autoIntervalArg = args[args.indexOf('--interval') + 1]
    const autoInterval = autoIntervalArg ? parseInt(autoIntervalArg, 10) : 300_000
    if (autonomous) {
      if (opts.providerSelection && opts.providerPolicy) {
        const decision = decideProviderUse(opts.providerSelection, {
          policy: opts.providerPolicy,
          autonomous: true,
          stateDir: join(opts.memoryDir, 'state'),
        })
        if (!decision.allowed) {
          console.error(`[${opts.serviceName}] Autonomous mode blocked by provider policy: ${decision.reason}`)
          return
        }
      }
      console.log(`[${opts.serviceName}] Autonomous mode: tick every ${autoInterval / 1000}s when idle`)
      setInterval(async () => {
        const result = await handle.runExclusive(async () => {
          const start = Date.now()
          const tickResult = await opts.agent.tick()
          tickCount++
          const actions = tickResult.actions.map(a => a.type).join(', ') || '(none)'
          console.log(`[${opts.serviceName}] Autonomous tick #${tickCount}: ${actions} (${Date.now() - start}ms, quality ${tickResult.observation.outputQuality}/5)`)
          return tickResult
        })
        if (!result) console.log(`[${opts.serviceName}] Autonomous tick skipped: chat in progress`)
      }, autoInterval)
    }
    return
  }

  if (mode === 'chat') {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log(`[${opts.serviceName}] Interactive chat mode`)
    console.log(`[${opts.serviceName}] Provider: ${opts.providerName ?? 'unknown'}`)
    let closed = false
    rl.on('close', () => { closed = true })
    const prompt = () => {
      if (closed) return
      rl.question('\x1b[36mUser>\x1b[0m ', async input => {
        const trimmed = input.trim()
        if (!trimmed) { prompt(); return }
        opts.peerBridge.onBeforeChat('User', trimmed)
        let streamedText = ''
        const started = Date.now()
        try {
          const result = await opts.agent.chat(trimmed, { from: 'User', onStream: chunk => { process.stdout.write(chunk); streamedText += chunk } })
          if (streamedText) process.stdout.write('\n')
          console.log(`\x1b[32m${opts.serviceName}>\x1b[0m (${((Date.now() - started) / 1000).toFixed(1)}s, actions: ${(result.actions ?? []).join(', ') || 'none'}, quality: ${result.quality}/5)\n`)
          console.log(result.response || result.thought.slice(0, 2000))
        } catch (err) {
          console.error(`\x1b[31m[error]\x1b[0m ${err instanceof Error ? err.message : err}`)
        }
        console.log()
        prompt()
      })
    }
    prompt()
    process.on('SIGINT', () => { rl.close(); process.exit(0) })
    return
  }

  if (mode === 'loop') {
    const intervalArg = args[args.indexOf('--interval') + 1]
    const interval = intervalArg ? parseInt(intervalArg, 10) : 300_000
    opts.agent.start(interval)
    process.on('SIGINT', () => { opts.agent.stop(); process.exit(0) })
    process.on('SIGTERM', () => { opts.agent.stop(); process.exit(0) })
    return
  }

  if (mode === 'watch') {
    const inboxPath = join(messagesDir, 'from-kuro.md')
    let ticking = false
    let lastSize = 0
    let lastTickTime = 0
    const minIntervalArg = args[args.indexOf('--min-interval') + 1]
    const idleTickArg = args[args.indexOf('--idle-tick') + 1]
    const minInterval = minIntervalArg ? parseInt(minIntervalArg, 10) * 60_000 : 600_000
    const idleTickInterval = idleTickArg ? parseInt(idleTickArg, 10) * 60_000 : 1_800_000
    try { lastSize = statSync(inboxPath).size } catch {}
    async function doTick(reason: string): Promise<void> {
      if (ticking) return
      const elapsed = Date.now() - lastTickTime
      if (lastTickTime > 0 && elapsed < minInterval) return
      console.log(`[${opts.serviceName}] Running tick (${reason})...`)
      ticking = true
      lastTickTime = Date.now()
      try { await runSingleTick() } finally { ticking = false }
    }
    if (lastSize > 0) doTick('existing message').catch(console.error)
    watchFile(inboxPath, { interval: 5_000 }, (curr, prev) => {
      if (curr.size > 0 && curr.mtimeMs > prev.mtimeMs) doTick(`new message, ${curr.size} bytes`).catch(console.error)
    })
    const idleTimer = setInterval(() => { if (!ticking) doTick('idle tick').catch(console.error) }, idleTickInterval)
    process.on('SIGINT', () => { clearInterval(idleTimer); process.exit(0) })
    process.on('SIGTERM', () => { clearInterval(idleTimer); process.exit(0) })
    return
  }

  await runSingleTick()
}
