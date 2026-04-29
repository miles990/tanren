/**
 * Tanren — Resilient Provider
 *
 * Wraps multiple LLM providers in a fallback chain.
 * If the primary fails, tries the next one.
 */

import type { LLMProvider } from './types.js'

export interface ResilientProviderOptions {
  chain: Array<{ name: string; provider: LLMProvider }>
  onFallback?: (failed: string, next: string, error: string) => void
}

export function createResilientProvider(opts: ResilientProviderOptions): LLMProvider {
  return {
    async think(context: string, systemPrompt: string): Promise<string> {
      let lastError: Error | null = null

      for (const { name, provider } of opts.chain) {
        try {
          return await provider.think(context, systemPrompt)
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          const nextEntry = opts.chain[opts.chain.indexOf({ name, provider }) + 1]
          if (nextEntry && opts.onFallback) {
            opts.onFallback(name, nextEntry.name, lastError.message)
          }
        }
      }

      throw new Error(`All providers exhausted. Last error: ${lastError?.message}`)
    },
  }
}
