/**
 * Tanren — Error Classification
 *
 * Structured error taxonomy for better retry strategies.
 * Claude Code pattern: errors are information, not just failures.
 * Classified errors tell the agent WHAT went wrong and HOW to recover.
 */

export type ErrorType = 'TIMEOUT' | 'RATE_LIMIT' | 'NOT_FOUND' | 'PERMISSION' | 'PARSE' | 'NETWORK' | 'UNKNOWN'

export interface ClassifiedError {
  type: ErrorType
  message: string
  retryable: boolean
  guidance: string  // actionable advice for the agent
}

export function classifyError(error: unknown): ClassifiedError {
  const msg = error instanceof Error ? error.message : String(error)
  const lower = msg.toLowerCase()

  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborted')) {
    return { type: 'TIMEOUT', message: msg, retryable: true, guidance: 'Request took too long. Retry with simpler query or smaller scope.' }
  }
  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many')) {
    return { type: 'RATE_LIMIT', message: msg, retryable: true, guidance: 'Rate limited. Wait before retrying.' }
  }
  if (lower.includes('not found') || lower.includes('enoent') || lower.includes('404') || lower.includes('no such file')) {
    return { type: 'NOT_FOUND', message: msg, retryable: false, guidance: 'Resource not found. Check the path/URL and try a different one.' }
  }
  if (lower.includes('permission') || lower.includes('access denied') || lower.includes('403') || lower.includes('eacces')) {
    return { type: 'PERMISSION', message: msg, retryable: false, guidance: 'Permission denied. Try a different approach.' }
  }
  if (lower.includes('json') || lower.includes('parse') || lower.includes('syntax')) {
    return { type: 'PARSE', message: msg, retryable: false, guidance: 'Data format error. Check input format.' }
  }
  if (lower.includes('econnrefused') || lower.includes('econnreset') || lower.includes('network') || lower.includes('fetch failed')) {
    return { type: 'NETWORK', message: msg, retryable: true, guidance: 'Network error. Service may be down. Retry or try alternative.' }
  }

  return { type: 'UNKNOWN', message: msg, retryable: false, guidance: 'Unexpected error. Check the error message for clues.' }
}

/** Format a classified error for tool_result — agent sees structured info, not raw stack trace */
export function formatErrorForAgent(error: unknown, actionType: string): string {
  const classified = classifyError(error)
  return `[${actionType} ${classified.type}]: ${classified.message.slice(0, 200)}${classified.retryable ? ' (retryable)' : ''}\nGuidance: ${classified.guidance}`
}
