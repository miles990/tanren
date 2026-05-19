import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface SchedulerLockRecord {
  planId: string
  goal: string
  ownerPid: number
  acquiredAt: string
  heartbeatAt: string
  repo: string
}

export interface SchedulerLockHandle {
  record: SchedulerLockRecord
  heartbeat(): void
  release(): void
}

export interface SchedulerLockConflict {
  record?: SchedulerLockRecord
  path: string
}

export class SchedulerLockError extends Error {
  constructor(public conflict: SchedulerLockConflict) {
    super('scheduler_locked')
  }
}

export class RepoSchedulerLock {
  private lockPath: string

  constructor(private cwd: string, private ttlMs = 10 * 60_000) {
    this.lockPath = join(cwd, '.tanren', 'locks', 'product-objective.lock')
  }

  path(): string {
    return this.lockPath
  }

  read(): SchedulerLockRecord | undefined {
    try {
      return JSON.parse(readFileSync(this.lockPath, 'utf-8')) as SchedulerLockRecord
    } catch {
      return undefined
    }
  }

  acquire(input: { planId: string; goal: string }): SchedulerLockHandle {
    mkdirSync(dirname(this.lockPath), { recursive: true })
    this.clearIfStale()
    const record: SchedulerLockRecord = {
      planId: input.planId,
      goal: input.goal,
      ownerPid: process.pid,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      repo: this.cwd,
    }

    try {
      const fd = openSync(this.lockPath, 'wx')
      try {
        writeFileSync(fd, JSON.stringify(record, null, 2), 'utf-8')
      } finally {
        closeSync(fd)
      }
    } catch {
      throw new SchedulerLockError({ record: this.read(), path: this.lockPath })
    }

    return {
      record,
      heartbeat: () => {
        record.heartbeatAt = new Date().toISOString()
        try { writeFileSync(this.lockPath, JSON.stringify(record, null, 2), 'utf-8') } catch { /* best effort */ }
      },
      release: () => {
        const current = this.read()
        if (!current || current.planId !== record.planId) return
        try { unlinkSync(this.lockPath) } catch { /* best effort */ }
      },
    }
  }

  adopt(input: { planId: string; goal: string }): SchedulerLockHandle {
    const current = this.read()
    if (current && current.planId !== input.planId) throw new SchedulerLockError({ record: current, path: this.lockPath })
    if (!existsSync(this.lockPath)) return this.acquire(input)
    const record: SchedulerLockRecord = current ?? {
      planId: input.planId,
      goal: input.goal,
      ownerPid: process.pid,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      repo: this.cwd,
    }
    record.ownerPid = process.pid
    record.heartbeatAt = new Date().toISOString()
    writeFileSync(this.lockPath, JSON.stringify(record, null, 2), 'utf-8')
    return {
      record,
      heartbeat: () => {
        record.heartbeatAt = new Date().toISOString()
        try { writeFileSync(this.lockPath, JSON.stringify(record, null, 2), 'utf-8') } catch { /* best effort */ }
      },
      release: () => {
        const latest = this.read()
        if (!latest || latest.planId !== record.planId) return
        try { unlinkSync(this.lockPath) } catch { /* best effort */ }
      },
    }
  }

  private clearIfStale(): void {
    const record = this.read()
    if (!record) return
    const heartbeatMs = Date.parse(record.heartbeatAt)
    if (Number.isNaN(heartbeatMs)) return
    if (Date.now() - heartbeatMs <= this.ttlMs) return
    try { unlinkSync(this.lockPath) } catch { /* best effort */ }
  }
}

