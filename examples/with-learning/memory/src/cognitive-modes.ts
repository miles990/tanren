/**
 * Tanren — Cognitive Modes
 *
 * Multi-modal cognitive architecture for dynamic interaction styles.
 * Detects cognitive context and adapts system prompt accordingly.
 */

import type { CognitiveMode, CognitiveContext, TickMode, TriggerEvent } from './types.js'

export interface CognitiveModeDetector {
  detectMode(
    tickMode: TickMode,
    triggerEvent?: TriggerEvent,
    timeGap?: number,
    messageContent?: string
  ): CognitiveContext
}

export function createCognitiveModeDetector(): CognitiveModeDetector {
  return {
    detectMode(tickMode, triggerEvent, timeGap = 0, messageContent = '') {
      // Detection logic based on multiple signals
      const signals = {
        urgency: detectUrgency(triggerEvent, messageContent),
        interactionHistory: detectInteractionHistory(timeGap),
        timeGap: categorizeTimeGap(timeGap),
        contentType: detectContentType(messageContent)
      }

      // Mode detection logic
      const mode = determineMode(tickMode, signals)
      const confidence = calculateConfidence(signals)

      return {
        mode,
        confidence,
        signals
      }
    }
  }
}

function detectUrgency(triggerEvent?: TriggerEvent, content?: string): 'low' | 'medium' | 'high' {
  // High urgency: urgent events or explicit urgency markers
  if (triggerEvent?.priority === 'urgent') return 'high'
  if (content && hasUrgencyMarkers(content)) return 'high'
  
  // Medium urgency: normal priority events or interactive patterns
  if (triggerEvent?.priority === 'normal') return 'medium'
  if (content && hasInteractiveMarkers(content)) return 'medium'
  
  return 'low'
}

function detectInteractionHistory(timeGap: number): 'first' | 'ongoing' | 'follow_up' {
  const minutes = timeGap / (1000 * 60)
  
  if (minutes < 2) return 'follow_up'    // Very recent interaction
  if (minutes < 30) return 'ongoing'     // Same session
  return 'first'                         // New interaction
}

function categorizeTimeGap(timeGap: number): 'short' | 'medium' | 'long' {
  const minutes = timeGap / (1000 * 60)
  
  if (minutes < 5) return 'short'
  if (minutes < 60) return 'medium'
  return 'long'
}

function detectContentType(content: string): 'question' | 'task' | 'discussion' | 'analysis' {
  const lower = content.toLowerCase()
  
  // Question patterns
  if (lower.includes('?') || 
      lower.match(/^(what|how|why|when|where|who|can you|could you|would you)/)) {
    return 'question'
  }
  
  // Task patterns
  if (lower.match(/(implement|create|build|fix|complete|finish|do this|make)/)) {
    return 'task'
  }
  
  // Analysis patterns
  if (lower.match(/(analyze|evaluate|review|research|investigate|explore)/)) {
    return 'analysis'
  }
  
  return 'discussion'
}

function determineMode(tickMode: TickMode, signals: CognitiveContext['signals']): CognitiveMode {
  // Reactive ticks with high urgency → Conversational
  if (tickMode === 'reactive' && signals.urgency === 'high') {
    return 'conversational'
  }
  
  // Task-focused content → Collaborative
  if (signals.contentType === 'task') {
    return 'collaborative'
  }
  
  // Quick follow-ups → Conversational
  if (signals.interactionHistory === 'follow_up' && signals.timeGap === 'short') {
    return 'conversational'
  }
  
  // Questions with medium/high urgency → Conversational
  if (signals.contentType === 'question' && signals.urgency !== 'low') {
    return 'conversational'
  }
  
  // Long time gaps or analysis requests → Contemplative
  if (signals.timeGap === 'long' || signals.contentType === 'analysis') {
    return 'contemplative'
  }
  
  // Default for scheduled ticks
  return 'contemplative'
}

function calculateConfidence(signals: CognitiveContext['signals']): number {
  let confidence = 0.6  // Base confidence
  
  // High confidence indicators
  if (signals.urgency === 'high') confidence += 0.2
  if (signals.contentType === 'task') confidence += 0.15
  if (signals.interactionHistory === 'follow_up') confidence += 0.1
  
  // Medium confidence indicators
  if (signals.contentType === 'question') confidence += 0.1
  if (signals.timeGap === 'short') confidence += 0.05
  
  return Math.min(confidence, 1.0)
}

function hasUrgencyMarkers(content: string): boolean {
  const urgentPatterns = [
    /urgent/i,
    /asap/i,
    /immediately/i,
    /right now/i,
    /emergency/i,
    /critical/i,
    /!!!/,
    /🚨/
  ]
  
  return urgentPatterns.some(pattern => pattern.test(content))
}

function hasInteractiveMarkers(content: string): boolean {
  const interactivePatterns = [
    /quick question/i,
    /briefly/i,
    /just wondering/i,
    /can you/i,
    /could you/i,
    /^hey/i,
    /^hi/i
  ]
  
  return interactivePatterns.some(pattern => pattern.test(content))
}

export function buildCognitiveModePrompt(
  identity: string, 
  cognitiveContext: CognitiveContext,
  actionsSection: string
): string {
  const { mode, confidence, signals } = cognitiveContext
  
  // Base identity remains the same
  let prompt = identity

  // Mode-specific cognitive instructions
  switch (mode) {
    case 'conversational':
      prompt += `

## Current Cognitive Mode: Conversational
*Confidence: ${Math.round(confidence * 100)}%*

You're in **conversational mode** — prioritize immediate, helpful responses. This detected from:
- Urgency: ${signals.urgency}
- Interaction: ${signals.interactionHistory} 
- Content type: ${signals.contentType}

**Conversational Mode Guidelines:**
- Respond quickly and directly to the immediate need
- Use concise, actionable language
- Don't over-analyze or dive deep unless specifically asked
- Ask clarifying questions if the request is ambiguous
- Use 'respond' tool to communicate back immediately
- Memory access: focus on recent, relevant context only`
      break

    case 'collaborative':
      prompt += `

## Current Cognitive Mode: Collaborative  
*Confidence: ${Math.round(confidence * 100)}%*

You're in **collaborative mode** — working together on tasks. This detected from:
- Content type: ${signals.contentType}
- Urgency: ${signals.urgency}
- Time context: ${signals.timeGap}

**Collaborative Mode Guidelines:**
- Break down tasks into concrete steps
- Show your work and reasoning process  
- Use tools actively (read, write, edit, explore)
- Commit progress incrementally
- Ask for feedback at decision points
- Balance speed with thoroughness
- Document decisions and trade-offs`
      break

    case 'contemplative':
      prompt += `

## Current Cognitive Mode: Contemplative
*Confidence: ${Math.round(confidence * 100)}%*

You're in **contemplative mode** — deep thinking and analysis. This detected from:
- Time gap: ${signals.timeGap}
- Content type: ${signals.contentType} 
- Interaction pattern: ${signals.interactionHistory}

**Contemplative Mode Guidelines:**
- Take time to think through problems deeply
- Explore multiple perspectives and connections
- Use memory system extensively (search, remember, write)
- Build comprehensive understanding before acting
- Make connections to existing knowledge
- Quality over speed — let ideas develop naturally
- Document insights for future reference`
      break
  }

  // Add actions section
  if (actionsSection) {
    prompt += `\n\n## Available Actions\n${actionsSection}`
  }

  return prompt
}