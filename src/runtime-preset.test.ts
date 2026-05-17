import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createAgentRuntimePreset } from './runtime-preset.js'

describe('RuntimePreset', () => {
  it('exposes layered capabilities and keeps artifacts disabled without credentials', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-runtime-'))
    try {
      const runtime = createAgentRuntimePreset({
        baseDir: dir,
        memoryDir: join(dir, 'memory'),
        messagesDir: join(dir, 'messages'),
        mode: 'local-review',
        provider: 'local',
        enableAgora: false,
        enableKgNotifications: false,
        env: {
          LOCAL_LLM_URL: 'http://localhost:8000',
          LOCAL_LLM_MODEL: 'local-test',
          TANREN_ARTIFACT_PROVIDER: 'openai',
        } as NodeJS.ProcessEnv,
      })

      assert.equal(runtime.capabilities.llm.providerKey, 'local')
      assert.equal(runtime.capabilities.llm.cloud, false)
      assert.equal(runtime.capabilities.artifacts.enabled, false)
      assert.equal(runtime.capabilities.artifacts.reason, 'OPENAI_API_KEY not set')
      assert.deepEqual(runtime.capabilities.mcp.servers, [])
      assert.equal(runtime.capabilities.runtime.agora.enabled, false)
      assert.equal((runtime.config.actions ?? []).some(action => action.type === 'image_generate'), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('adds artifact actions and health metadata when artifact provider is configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-runtime-'))
    try {
      const runtime = createAgentRuntimePreset({
        baseDir: dir,
        memoryDir: join(dir, 'memory'),
        messagesDir: join(dir, 'messages'),
        mode: 'codex',
        provider: 'codex',
        enableAgora: false,
        enableKgNotifications: false,
        env: {
          TANREN_ARTIFACT_PROVIDER: 'openai',
          OPENAI_API_KEY: 'test-key',
        } as NodeJS.ProcessEnv,
      })

      assert.equal(runtime.capabilities.artifacts.enabled, true)
      assert.equal(runtime.capabilities.artifacts.defaultProvider, 'openai-artifacts')
      assert.equal(runtime.capabilities.artifacts.providers.length, 1)
      assert.equal((runtime.config.actions ?? []).some(action => action.type === 'image_generate'), true)
      assert.equal((runtime.config.actions ?? []).some(action => action.type === 'audio_generate'), true)

      const health = runtime.health()
      assert.equal(health.artifactsEnabled, true)
      assert.equal((health.artifacts as { enabled: boolean }).enabled, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prefers framework env names while keeping service-specific fallbacks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-runtime-'))
    try {
      const runtime = createAgentRuntimePreset({
        baseDir: dir,
        memoryDir: join(dir, 'memory'),
        messagesDir: join(dir, 'messages'),
        serviceName: 'akari',
        serviceEnvPrefix: 'AKARI',
        enableAgora: false,
        enableKgNotifications: false,
        env: {
          TANREN_MODE: 'local-review',
          AKARI_MODE: 'codex',
          TANREN_LLM_PROVIDER: 'local',
          TANREN_MODEL: 'tanren-model',
          AKARI_MODEL: 'akari-model',
          LOCAL_LLM_URL: 'http://localhost:8000',
          TANREN_ARTIFACT_PROVIDER: 'none',
        } as NodeJS.ProcessEnv,
      })

      assert.equal(runtime.providerSelection.mode, 'local-review')
      assert.equal(runtime.providerSelection.providerKey, 'local')
      assert.equal(runtime.providerSelection.model, 'tanren-model')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('applies task profiles from service env to provider capabilities and health', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-runtime-'))
    try {
      const runtime = createAgentRuntimePreset({
        baseDir: dir,
        memoryDir: join(dir, 'memory'),
        messagesDir: join(dir, 'messages'),
        serviceName: 'akari',
        serviceEnvPrefix: 'AKARI',
        mode: 'cloud-research',
        provider: 'agent-sdk',
        enableAgora: false,
        enableKgNotifications: false,
        env: {
          AKARI_TASK_PROFILE: 'deep-review',
          TANREN_ARTIFACT_PROVIDER: 'none',
        } as NodeJS.ProcessEnv,
      })

      assert.equal(runtime.taskProfile.name, 'deep-review')
      assert.equal(runtime.taskProfile.agentSdk?.maxTurns, 48)
      assert.equal(runtime.taskProfile.agentSdk?.timeoutMs, 900_000)
      assert.deepEqual(runtime.taskProfile.agentSdk?.allowedTools, ['Read', 'Grep', 'Glob'])
      assert.equal((runtime.health().taskProfile as { name: string }).name, 'deep-review')
      assert.equal(runtime.capabilities.taskProfile.name, 'deep-review')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exposes model router providers for capability-based routing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-runtime-'))
    try {
      const runtime = createAgentRuntimePreset({
        baseDir: dir,
        memoryDir: join(dir, 'memory'),
        messagesDir: join(dir, 'messages'),
        mode: 'codex',
        provider: 'codex',
        enableAgora: false,
        enableKgNotifications: false,
        extraModelProviders: {
          image: {
            capabilities: {
              input: { text: true, image: true, audio: false, pdf: false, file: false, url: true, streamRef: false },
              output: { text: true, image: false, audio: false, file: false, structured: true },
              streaming: { text: true, structured: false, toolCalls: false, media: false },
              tools: { native: false, parallel: false },
              state: { sessions: false },
            },
            async think() { return 'image' },
          },
        },
        env: {
          TANREN_ARTIFACT_PROVIDER: 'none',
        } as NodeJS.ProcessEnv,
      })

      assert.equal(runtime.capabilities.routing.modelProviders.length, 2)
      const routed = runtime.modelRouter.route({
        prompt: [
          { type: 'text', text: 'describe' },
          { type: 'media', mediaType: 'image/png', source: { type: 'url', url: 'https://example.test/a.png' } },
        ],
      }, { output: { structured: true } })
      assert.equal(routed.selected?.name, 'image')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('wraps the primary LLM with configured fallback providers and exposes health', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanren-runtime-'))
    try {
      const runtime = createAgentRuntimePreset({
        baseDir: dir,
        memoryDir: join(dir, 'memory'),
        messagesDir: join(dir, 'messages'),
        mode: 'local-review',
        provider: 'local',
        enableAgora: false,
        enableKgNotifications: false,
        providerRetryAttempts: 1,
        extraModelProviders: {
          fallback: {
            async think() { return 'fallback ok' },
          },
        },
        env: {
          LOCAL_LLM_URL: 'http://127.0.0.1:9',
          LOCAL_LLM_MODEL: 'local-test',
          TANREN_ARTIFACT_PROVIDER: 'none',
        } as NodeJS.ProcessEnv,
      })

      const provider = runtime.config.llm!
      const text = await provider.think('hello', 'system')
      assert.equal(text, 'fallback ok')
      assert.equal(runtime.providerHealth.degraded, true)
      assert.equal(runtime.providerHealth.activeProvider, 'fallback')
      assert.equal((runtime.health().providerHealth as { activeProvider: string }).activeProvider, 'fallback')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
