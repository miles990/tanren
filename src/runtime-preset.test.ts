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
        mode: 'local-review',
        provider: 'local',
        enableAgora: false,
        enableKgNotifications: false,
        env: {
          LOCAL_LLM_URL: 'http://localhost:8000',
          LOCAL_LLM_MODEL: 'local-test',
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
})
