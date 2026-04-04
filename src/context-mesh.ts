/**
 * Tanren — Causal Context Mesh
 *
 * A lightweight causal graph that unifies four capabilities:
 * 1. Dependency tracking (what depends on what)
 * 2. Causal tracking (what caused what)
 * 3. Context threading (cross-tick work tracking)
 * 4. Pattern-based question generation (what questions worked before)
 *
 * Storage: JSONL (appendable, git-friendly, streamable).
 * Query: 2-hop neighborhood with recency × relevance scoring.
 * Update: framework auto-registers ticks, agent manually connects causes.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { PerceptionPlugin, ActionHandler, Action, ActionContext } from './types.js'

// === Types ===

export interface ContextNode {
  type: 'node'
  id: string
  tick: number
  timestamp: string
  context: string              // what this node represents
  actions?: string[]           // actions taken in this context
  metadata?: Record<string, unknown>
}

export interface ContextEdge {
  type: 'edge'
  from: string
  to: string
  relation: 'depends-on' | 'caused-by' | 'builds-on' | 'contradicts' | 'references' | 'threads-into'
  weight: number               // 0-1, strength of connection
  tick: number                 // when this edge was created
}

type GraphEntry = ContextNode | ContextEdge

// === Core ===

export function createContextMesh(memoryDir: string) {
  const meshDir = join(memoryDir, 'mesh')
  const graphPath = join(meshDir, 'context-graph.jsonl')

  // Ensure directory
  if (!existsSync(meshDir)) mkdirSync(meshDir, { recursive: true })

  // In-memory cache (loaded lazily)
  let nodes: Map<string, ContextNode> = new Map()
  let edges: ContextEdge[] = []
  let loaded = false

  function ensureLoaded(): void {
    if (loaded) return
    if (existsSync(graphPath)) {
      try {
        const raw = readFileSync(graphPath, 'utf-8')
        for (const line of raw.split('\n').filter(Boolean)) {
          try {
            const entry = JSON.parse(line) as GraphEntry
            if (entry.type === 'node') nodes.set(entry.id, entry)
            else if (entry.type === 'edge') edges.push(entry)
          } catch { continue }
        }
      } catch { /* start fresh */ }
    }
    loaded = true
  }

  function append(entry: GraphEntry): void {
    try {
      appendFileSync(graphPath, JSON.stringify(entry) + '\n')
    } catch { /* fire-and-forget */ }
  }

  // === Public API ===

  const mesh = {
    /**
     * Register a new context node (auto-called by framework each tick).
     */
    register(id: string, tick: number, context: string, actions?: string[], metadata?: Record<string, unknown>): void {
      ensureLoaded()
      const node: ContextNode = {
        type: 'node',
        id,
        tick,
        timestamp: new Date().toISOString(),
        context,
        actions,
        metadata,
      }
      nodes.set(id, node)
      append(node)
    },

    /**
     * Connect two nodes with a causal/dependency relationship.
     * Called by agent when it discovers a connection.
     */
    connect(fromId: string, toId: string, relation: ContextEdge['relation'], tick: number, weight = 0.8): void {
      ensureLoaded()
      const edge: ContextEdge = { type: 'edge', from: fromId, to: toId, relation, weight, tick }
      edges.push(edge)
      append(edge)
    },

    /**
     * Get relevant context for current situation (2-hop neighborhood).
     * Used by perception to inject historical context.
     */
    getRelevantContext(currentTick: number, maxNodes = 5): ContextNode[] {
      ensureLoaded()
      if (nodes.size === 0) return []

      // Score all nodes by recency + connection density
      const scores = new Map<string, number>()
      const currentId = `tick-${currentTick}`

      for (const [id, node] of nodes) {
        // Recency score: exponential decay
        const tickAge = currentTick - node.tick
        const recency = Math.exp(-tickAge / 20) // half-life ~14 ticks

        // Connection score: nodes with more edges are more important
        const connections = edges.filter(e => e.from === id || e.to === id).length
        const connectivity = Math.min(1, connections / 5)

        // Direct neighbor bonus
        const isNeighbor = edges.some(e =>
          (e.from === currentId && e.to === id) || (e.to === currentId && e.from === id)
        )
        const neighborBonus = isNeighbor ? 0.5 : 0

        // 2-hop bonus
        const neighborIds = new Set(
          edges.filter(e => e.from === currentId || e.to === currentId)
            .map(e => e.from === currentId ? e.to : e.from)
        )
        const isTwoHop = edges.some(e =>
          (neighborIds.has(e.from) && e.to === id) || (neighborIds.has(e.to) && e.from === id)
        )
        const twoHopBonus = isTwoHop ? 0.25 : 0

        scores.set(id, recency * 0.4 + connectivity * 0.2 + neighborBonus + twoHopBonus)
      }

      return [...scores.entries()]
        .sort(([, a], [, b]) => b - a)
        .slice(0, maxNodes)
        .map(([id]) => nodes.get(id)!)
        .filter(Boolean)
    },

    /**
     * Find causal chain: trace back from an effect to its causes.
     */
    traceBack(nodeId: string, maxDepth = 3): Array<{ node: ContextNode; edge: ContextEdge }> {
      ensureLoaded()
      const chain: Array<{ node: ContextNode; edge: ContextEdge }> = []
      const visited = new Set<string>()
      let current = nodeId

      for (let depth = 0; depth < maxDepth; depth++) {
        const causeEdge = edges
          .filter(e => e.to === current && !visited.has(e.from))
          .sort((a, b) => b.weight - a.weight)[0]
        if (!causeEdge) break

        const causeNode = nodes.get(causeEdge.from)
        if (!causeNode) break

        chain.push({ node: causeNode, edge: causeEdge })
        visited.add(causeEdge.from)
        current = causeEdge.from
      }

      return chain
    },

    /**
     * Get active threads — sequences of connected nodes representing ongoing work.
     */
    getActiveThreads(currentTick: number, maxAge = 20): Array<{ focus: string; nodes: ContextNode[]; lastTick: number }> {
      ensureLoaded()

      // Find 'threads-into' chains
      const threadEdges = edges.filter(e => e.relation === 'threads-into')
      const threadHeads = new Set<string>()

      // Find nodes that are thread-starts (referenced as 'from' but not as 'to')
      for (const e of threadEdges) {
        threadHeads.add(e.from)
      }
      for (const e of threadEdges) {
        threadHeads.delete(e.to)
      }

      const threads: Array<{ focus: string; nodes: ContextNode[]; lastTick: number }> = []

      for (const headId of threadHeads) {
        const threadNodes: ContextNode[] = []
        let current = headId
        const visited = new Set<string>()

        while (current && !visited.has(current)) {
          visited.add(current)
          const node = nodes.get(current)
          if (node) threadNodes.push(node)

          const next = threadEdges.find(e => e.from === current)
          current = next?.to ?? ''
        }

        if (threadNodes.length > 0) {
          const lastTick = Math.max(...threadNodes.map(n => n.tick))
          if (currentTick - lastTick <= maxAge) {
            threads.push({
              focus: threadNodes[0].context,
              nodes: threadNodes,
              lastTick,
            })
          }
        }
      }

      return threads
    },

    /** Get stats for debugging */
    stats(): { nodes: number; edges: number; relations: Record<string, number> } {
      ensureLoaded()
      const relations: Record<string, number> = {}
      for (const e of edges) {
        relations[e.relation] = (relations[e.relation] ?? 0) + 1
      }
      return { nodes: nodes.size, edges: edges.length, relations }
    },
  }

  return mesh
}

// === Framework Integration ===

/**
 * Create a perception plugin that injects relevant causal context.
 */
export function createMeshPerception(mesh: ReturnType<typeof createContextMesh>): PerceptionPlugin {
  return {
    name: 'causal-context',
    category: 'self-awareness',
    fn: () => {
      // Get current tick from most recent node
      const stats = mesh.stats()
      if (stats.nodes === 0) return ''

      const relevant = mesh.getRelevantContext(999999, 5) // use large tick to get most recent
      if (relevant.length === 0) return ''

      const lines = ['<causal-context>']

      // Active threads
      const threads = mesh.getActiveThreads(999999)
      if (threads.length > 0) {
        lines.push('  Active threads:')
        for (const t of threads.slice(0, 3)) {
          lines.push(`    - ${t.focus} (${t.nodes.length} steps, last tick ${t.lastTick})`)
        }
      }

      // Recent related context
      lines.push('  Related context:')
      for (const node of relevant.slice(0, 5)) {
        lines.push(`    - [tick ${node.tick}] ${node.context}${node.actions ? ` (${node.actions.join('→')})` : ''}`)
      }

      lines.push(`  Graph: ${stats.nodes} nodes, ${stats.edges} edges`)
      lines.push('</causal-context>')

      return lines.join('\n')
    },
  }
}

/**
 * Create action handler for agent to manually connect nodes.
 */
export function createMeshAction(mesh: ReturnType<typeof createContextMesh>): ActionHandler {
  return {
    type: 'connect',
    description: 'Connect two context nodes in the causal mesh. Use when you discover a relationship between current work and past work.',
    toolSchema: {
      properties: {
        from: { type: 'string', description: 'Source node ID (e.g. "tick-159" or a topic name)' },
        to: { type: 'string', description: 'Target node ID' },
        relation: { type: 'string', description: 'Relationship type: depends-on, caused-by, builds-on, contradicts, references, threads-into' },
      },
      required: ['from', 'to', 'relation'],
    },
    async execute(action: Action) {
      const from = (action.input?.from as string) ?? ''
      const to = (action.input?.to as string) ?? ''
      const relation = (action.input?.relation as string) ?? 'references'
      if (!from || !to) return 'Error: from and to are required'
      mesh.connect(from, to, relation as ContextEdge['relation'], 0)
      return `Connected: ${from} →[${relation}]→ ${to}`
    },
  }
}

export type ContextMesh = ReturnType<typeof createContextMesh>
