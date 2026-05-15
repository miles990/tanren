import type { ProviderCapabilities } from './types.js'

export const TEXT_ONLY_CAPABILITIES: ProviderCapabilities = {
  input: { text: true, image: false, audio: false, pdf: false, file: false, url: false, streamRef: false },
  output: { text: true, image: false, audio: false, file: false, structured: false },
  streaming: { text: true, structured: false, toolCalls: false, media: false },
  tools: { native: false, parallel: false },
  state: { sessions: false },
}

export const ANTHROPIC_CAPABILITIES: ProviderCapabilities = {
  input: { text: true, image: true, audio: false, pdf: true, file: false, url: true, streamRef: false },
  output: { text: true, image: false, audio: false, file: false, structured: true },
  streaming: { text: true, structured: false, toolCalls: true, media: false },
  tools: { native: true, parallel: false },
  state: { sessions: false },
}

export const OPENAI_COMPAT_CAPABILITIES: ProviderCapabilities = {
  input: { text: true, image: true, audio: true, pdf: false, file: false, url: true, streamRef: false },
  output: { text: true, image: false, audio: false, file: false, structured: true },
  streaming: { text: true, structured: true, toolCalls: true, media: false },
  tools: { native: true, parallel: true },
  state: { sessions: false },
}

export const GEMINI_CAPABILITIES: ProviderCapabilities = {
  input: { text: true, image: true, audio: true, pdf: true, file: true, url: true, streamRef: false },
  output: { text: true, image: true, audio: true, file: true, structured: true },
  streaming: { text: true, structured: true, toolCalls: false, media: true },
  tools: { native: true, parallel: false },
  state: { sessions: false },
}

export const MANAGED_AGENT_CAPABILITIES: ProviderCapabilities = {
  input: { text: true, image: true, audio: false, pdf: true, file: true, url: true, streamRef: false },
  output: { text: true, image: false, audio: false, file: true, structured: true },
  streaming: { text: true, structured: false, toolCalls: true, media: false },
  tools: { native: true, parallel: false },
  state: { sessions: true },
}

export const AGENT_SDK_CAPABILITIES: ProviderCapabilities = {
  ...TEXT_ONLY_CAPABILITIES,
  input: { ...TEXT_ONLY_CAPABILITIES.input, file: true },
  tools: { native: true, parallel: false },
  state: { sessions: true },
}
