/**
 * Tanren — Self-Capability Mapping
 * Tracks task outcomes to build a map of what the agent can reliably do.
 * Built by Akari, 2026-04-01.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"

export interface TaskRecord {
  id: string
  tick: number
  timestamp: string
  taskType: "research" | "implementation" | "interaction" | "verification"
  complexity: "simple" | "moderate" | "complex"
  description: string
  outcome: "success" | "partial" | "fail"
  actionsUsed: string[]
  duration: number
  notes?: string
}

export interface CapabilityReport {
  totalTasks: number
  successRate: number
  byType: Record<string, { total: number; successRate: number }>
  byComplexity: Record<string, { total: number; successRate: number }>
  strengths: string[]
  weaknesses: string[]
  recentTrend: "improving" | "stable" | "declining"
}

interface CapabilityState {
  records: TaskRecord[]
  lastUpdated: string
}

export function createCapabilityMap(filePath: string) {
  let state: CapabilityState = { records: [], lastUpdated: new Date().toISOString() }

  function load(): void {
    try {
      if (existsSync(filePath)) {
        state = JSON.parse(readFileSync(filePath, "utf-8"))
      }
    } catch { state = { records: [], lastUpdated: new Date().toISOString() } }
  }

  function save(): void {
    try {
      const dir = dirname(filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(filePath, JSON.stringify(state, null, 2))
    } catch { /* fire-and-forget */ }
  }

  function record(task: Omit<TaskRecord, "id" | "timestamp">): void {
    state.records.push({
      ...task,
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
    })
    state.lastUpdated = new Date().toISOString()
    if (state.records.length > 200) state.records = state.records.slice(-200)
    save()
  }

  function getReport(): CapabilityReport {
    const records = state.records
    const total = records.length
    if (total === 0) return { totalTasks: 0, successRate: 0, byType: {}, byComplexity: {}, strengths: [], weaknesses: [], recentTrend: "stable" }

    const successes = records.filter(r => r.outcome === "success").length
    const successRate = successes / total

    const byType: Record<string, { total: number; successRate: number }> = {}
    const byComplexity: Record<string, { total: number; successRate: number }> = {}

    for (const type of ["research", "implementation", "interaction", "verification"]) {
      const subset = records.filter(r => r.taskType === type)
      if (subset.length > 0) {
        byType[type] = { total: subset.length, successRate: subset.filter(r => r.outcome === "success").length / subset.length }
      }
    }

    for (const cx of ["simple", "moderate", "complex"]) {
      const subset = records.filter(r => r.complexity === cx)
      if (subset.length > 0) {
        byComplexity[cx] = { total: subset.length, successRate: subset.filter(r => r.outcome === "success").length / subset.length }
      }
    }

    const strengths = Object.entries(byType).filter(([, v]) => v.successRate >= 0.8 && v.total >= 3).map(([k]) => k)
    const weaknesses = Object.entries(byType).filter(([, v]) => v.successRate < 0.5 && v.total >= 2).map(([k]) => k)

    const recent = records.slice(-10)
    const recentRate = recent.filter(r => r.outcome === "success").length / recent.length
    const olderRate = total > 10 ? records.slice(0, -10).filter(r => r.outcome === "success").length / (total - 10) : recentRate
    const recentTrend = recentRate > olderRate + 0.1 ? "improving" : recentRate < olderRate - 0.1 ? "declining" : "stable"

    return { totalTasks: total, successRate, byType, byComplexity, strengths, weaknesses, recentTrend }
  }

  return { load, save, record, getReport, getRecords: () => state.records }
}

export type CapabilityMapSystem = ReturnType<typeof createCapabilityMap>
