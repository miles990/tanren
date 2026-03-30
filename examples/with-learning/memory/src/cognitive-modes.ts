/**
 * Tanren — Cognitive Modes Module
 * 
 * Detects and manages different cognitive modes based on interaction context.
 * Switches between contemplative, conversational, and collaborative thinking styles.
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
      const signals: CognitiveContext['signals'] = {}
      
      // Detect urgency signals
      if (triggerEvent?.priority === 'urgent' || 
          messageContent.toLowerCase().includes('urgent') ||
          messageContent.toLowerCase().includes('quick')) {
        signals.urgency = 'high'
      } else if (triggerEvent?.priority === 'low' || 
                 messageContent.toLowerCase().includes('when you have time')) {
        signals.urgency = 'low'
      } else {
        signals.urgency = 'medium'
      }
      
      // Detect interaction history patterns
      if (tickMode === 'reactive') {
        if (timeGap < 5 * 60 * 1000) { // 5 minutes
          signals.interactionHistory = 'ongoing'
        } else if (timeGap < 60 * 60 * 1000) { // 1 hour
          signals.interactionHistory = 'follow_up'
        } else {
          signals.interactionHistory = 'first'
        }
      } else {
        signals.interactionHistory = 'first'
      }
      
      // Detect time gap categories
      if (timeGap < 5 * 60 * 1000) {
        signals.timeGap = 'short'
      } else if (timeGap < 60 * 60 * 1000) {
        signals.timeGap = 'medium'
      } else {
        signals.timeGap = 'long'
      }
      
      // Detect content type
      if (messageContent.includes('?') || messageContent.toLowerCase().startsWith('what') ||
          messageContent.toLowerCase().startsWith('how') || messageContent.toLowerCase().startsWith('why')) {
        signals.contentType = 'question'
      } else if (messageContent.toLowerCase().includes('implement') || 
                 messageContent.toLowerCase().includes('code') ||
                 messageContent.toLowerCase().includes('build')) {
        signals.contentType = 'task'
      } else if (messageContent.toLowerCase().includes('think') || 
                 messageContent.toLowerCase().includes('analysis') ||
                 messageContent.toLowerCase().includes('research')) {
        signals.contentType = 'analysis'
      } else {
        signals.contentType = 'discussion'
      }
      
      // Mode detection logic
      let mode: CognitiveMode = 'contemplative'  // default
      let confidence = 0.5
      
      // High confidence conversational mode
      if (signals.urgency === 'high' && signals.timeGap === 'short') {
        mode = 'conversational'
        confidence = 0.9
      }
      // High confidence collaborative mode  
      else if (signals.contentType === 'task' && signals.interactionHistory === 'ongoing') {
        mode = 'collaborative'
        confidence = 0.85
      }
      // Medium confidence conversational mode
      else if (signals.contentType === 'question' && tickMode === 'reactive') {
        mode = 'conversational'
        confidence = 0.7
      }
      // Medium confidence collaborative mode
      else if (signals.contentType === 'task') {
        mode = 'collaborative'
        confidence = 0.65
      }
      // High confidence contemplative mode
      else if (signals.contentType === 'analysis' || tickMode === 'scheduled') {
        mode = 'contemplative'
        confidence = 0.8
      }
      
      return {
        mode,
        confidence,
        signals
      }
    }
  }
}

/**
 * Build mode-specific system prompts that reshape cognitive style
 */
export function buildCognitiveModePrompt(
  baseIdentity: string, 
  context: CognitiveContext,
  actionPrompt: string
): string {
  const modeInstructions = getModeInstructions(context.mode)
  
  return `${baseIdentity}

## Current Cognitive Mode: ${context.mode.toUpperCase()}

${modeInstructions}

${actionPrompt}`
}

function getModeInstructions(mode: CognitiveMode): string {
  switch (mode) {
    case 'conversational':
      return `**Conversational Mode Active**: Respond quickly and directly. Focus on immediate clarity over depth. Get to the point. Use simple, clear language. If you need more context, ask specific questions rather than exploring all angles.

Key behaviors:
- Lead with the most important point
- Be concise but helpful  
- Ask clarifying questions if needed
- Avoid lengthy analysis in favor of actionable answers`

    case 'collaborative':
      return `**Collaborative Mode Active**: Work iteratively on the task at hand. Think step-by-step through the problem. Break down complex work into manageable pieces. Focus on practical implementation over theoretical exploration.

Key behaviors:
- Break tasks into clear steps
- Show your working/reasoning process
- Suggest concrete next actions
- Build on previous work rather than starting from scratch`

    case 'contemplative':
      return `**Contemplative Mode Active**: Think deeply and systematically. Explore connections and implications. Consider multiple angles and perspectives. Take time to synthesize insights from different domains.

Key behaviors:
- Examine problems from multiple angles
- Make connections to broader patterns
- Synthesize insights from your memory
- Balance depth with practical relevance`

    default:
      return ''
  }
}