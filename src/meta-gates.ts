/**
 * Meta-Gates for Cognitive Blind Spots
 * 
 * These gates detect patterns where the agent's cognition itself
 * becomes the limiting factor. Unlike behavioral gates that catch
 * action patterns, meta-gates catch thinking patterns.
 */

import type { Gate, GateContext } from './types.js'

// === Meta-Gate: Confirmation Loop ===
// Detects when agent keeps seeking validation for the same insight
// without moving to implementation or new exploration

export function createConfirmationLoopGate(threshold: number = 4): Gate {
  const recentInsights = new Map<string, number>()
  
  return {
    name: 'confirmation-loop',
    description: `Block after ${threshold} variations of the same insight without progression`,
    check(ctx) {
      const thought = ctx.tick.thought.toLowerCase()
      
      // Extract key concepts (simplified heuristic)
      const concepts = thought.match(/\b\w{4,}\b/g) || []
      const conceptSet = new Set(concepts)
      
      // Check similarity to recent insights
      for (const [pastConcepts, count] of recentInsights) {
        const pastSet = new Set(pastConcepts.split(','))
        const overlap = [...conceptSet].filter(c => pastSet.has(c)).length
        const similarity = overlap / Math.max(conceptSet.size, pastSet.size)
        
        if (similarity > 0.6) { // 60% concept overlap
          recentInsights.set(pastConcepts, count + 1)
          
          if (count + 1 >= threshold) {
            return {
              action: 'block',
              message: `Confirmation loop detected: ${count + 1} iterations of similar insight. You're circling rather than progressing. Try: (1) implement what you already know, (2) seek contradictory evidence, or (3) explore a completely different angle.`
            }
          }
          return { action: 'pass' }
        }
      }
      
      // Store new insight pattern
      const conceptKey = [...conceptSet].sort().join(',')
      recentInsights.set(conceptKey, 1)
      
      // Cleanup old entries (keep last 10)
      if (recentInsights.size > 10) {
        const firstKey = recentInsights.keys().next().value
        if (firstKey) recentInsights.delete(firstKey)
      }
      
      return { action: 'pass' }
    }
  }
}

// === Meta-Gate: Abstract Ascension ===
// Warns when agent keeps moving to higher levels of abstraction
// without grounding in concrete examples or implementation

export function createAbstractAscensionGate(threshold: number = 3): Gate {
  let consecutiveAbstract = 0
  
  const abstractMarkers = [
    'framework', 'paradigm', 'meta-', 'higher-order', 'philosophical',
    'conceptual', 'theoretical', 'general principle', 'abstraction',
    'pattern of patterns', 'overarching', 'fundamental'
  ]
  
  const concreteMarkers = [
    'example', 'specific', 'implement', 'code', 'file', 'step',
    'test', 'run', 'execute', 'measure', 'data', 'result'
  ]
  
  return {
    name: 'abstract-ascension',
    description: `Warn after ${threshold} consecutive ticks of increasing abstraction without grounding`,
    check(ctx) {
      const thought = ctx.tick.thought.toLowerCase()
      
      const abstractScore = abstractMarkers.reduce((score, marker) => 
        score + (thought.includes(marker) ? 1 : 0), 0)
      const concreteScore = concreteMarkers.reduce((score, marker) => 
        score + (thought.includes(marker) ? 1 : 0), 0)
        
      if (abstractScore > concreteScore && abstractScore >= 2) {
        consecutiveAbstract++
        
        if (consecutiveAbstract >= threshold) {
          return {
            action: 'warn',
            message: `Abstract ascension detected: ${consecutiveAbstract} consecutive ticks moving to higher abstraction levels. Ground your insights with: (1) concrete examples, (2) implementation attempts, or (3) measurable tests.`
          }
        }
      } else if (concreteScore > abstractScore) {
        consecutiveAbstract = 0
      }
      
      return { action: 'pass' }
    }
  }
}

// === Meta-Gate: Expertise Tunnel ===
// Detects when agent applies the same analytical lens repeatedly
// Missing opportunities for fresh perspective

export function createExpertiseTunnelGate(threshold: number = 5): Gate {
  const recentLenses = new Map<string, number>()
  
  const knownLenses = [
    'constraint', 'interface', 'cognitive', 'design', 'architecture',
    'system', 'pattern', 'framework', 'model', 'theory', 'principle',
    'optimization', 'emergence', 'complexity', 'feedback', 'alignment'
  ]
  
  return {
    name: 'expertise-tunnel',
    description: `Warn after ${threshold} ticks using the same analytical lens`,
    check(ctx) {
      const thought = ctx.tick.thought.toLowerCase()
      
      // Detect which lens is being used
      let dominantLens = 'general'
      let maxCount = 0
      
      for (const lens of knownLenses) {
        const count = (thought.match(new RegExp(lens, 'g')) || []).length
        if (count > maxCount) {
          maxCount = count
          dominantLens = lens
        }
      }
      
      if (maxCount >= 2) { // Lens is significantly present
        const currentCount = (recentLenses.get(dominantLens) || 0) + 1
        recentLenses.set(dominantLens, currentCount)
        
        // Reset other lens counters
        for (const [lens, count] of recentLenses) {
          if (lens !== dominantLens) {
            recentLenses.set(lens, Math.max(0, count - 0.5))
          }
        }
        
        if (currentCount >= threshold) {
          return {
            action: 'warn',
            message: `Expertise tunnel detected: ${currentCount} consecutive uses of "${dominantLens}" lens. Consider alternative perspectives: anthropological, historical, economic, artistic, or domain-specific angles that might reveal blind spots.`
          }
        }
      }
      
      return { action: 'pass' }
    }
  }
}

// === Utility: Create All Meta-Gates ===
export function createAllMetaGates(): Gate[] {
  return [
    createConfirmationLoopGate(),
    createAbstractAscensionGate(),
    createExpertiseTunnelGate()
  ]
}