// Reads every agent on this Orca host through `orca worktree ps --json`, the same rows Orca's
// sidebar and phone app draw from. The plugin API's agents.list only covers the focused
// workspace, so the worker asks the CLI instead and trims the answer to what the office draws.
import type { OrcaWorkerApi } from 'orca/worker'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Desk, Floor, OfficeSnapshot, Specialist, Staff, StaffState } from './protocol'

const CLI_CANDIDATES = [
  '/Applications/Orca.app/Contents/Resources/bin/orca',
  `${process.env.HOME ?? ''}/Applications/Orca.app/Contents/Resources/bin/orca`
]
const CLI_TIMEOUT_MS = 8000

function cliPath(): string {
  return CLI_CANDIDATES.find((p) => existsSync(p)) ?? 'orca'
}

function runPs(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      cliPath(),
      ['worktree', 'ps', '--json'],
      { timeout: CLI_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error && !stdout) return reject(error)
        try {
          resolve(JSON.parse(stdout))
        } catch (parseError) {
          reject(parseError)
        }
      }
    )
  })
}

type Row = Record<string, unknown>
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function staffState(row: Row): StaffState {
  const state = row.state
  if (state === 'working') return row.workingMode === 'monitoring' ? 'monitoring' : 'working'
  if (state === 'waiting' || state === 'blocked' || state === 'done') return state
  return 'idle'
}

function specialistState(state: unknown): StaffState {
  if (state === 'working' || state === 'waiting' || state === 'blocked' || state === 'done') {
    return state
  }
  return 'idle'
}

function toStaff(row: Row): Staff {
  const subs = Array.isArray(row.subagents) ? (row.subagents as Row[]) : []
  const specialists: Specialist[] = subs.map((s) => ({
    id: String(s.id ?? ''),
    role: str(s.agentType),
    task: str(s.description),
    state: specialistState(s.state)
  }))
  return {
    id: String(row.paneKey ?? ''),
    agent: str(row.agentType),
    name: str(row.conversationName) ?? str(row.displayName) ?? str(row.taskTitle),
    task: str(row.taskTitle) ?? str(row.prompt)?.slice(0, 140) ?? null,
    tool: str(row.toolName),
    said: str(row.lastAssistantMessage)?.split('\n')[0]?.slice(0, 120) ?? null,
    state: staffState(row),
    since: typeof row.stateStartedAt === 'number' ? row.stateStartedAt : 0,
    specialists
  }
}

export function toSnapshot(raw: unknown, at: number): OfficeSnapshot {
  const result = (raw as { result?: { worktrees?: Row[] } })?.result
  const worktrees = Array.isArray(result?.worktrees) ? result.worktrees : []
  const floors = new Map<string, Desk[]>()
  for (const w of worktrees) {
    if (w.isArchived === true) continue
    const agents = Array.isArray(w.agents) ? (w.agents as Row[]) : []
    if (agents.length === 0) continue
    const repo = str(w.repo) ?? 'Other'
    const branch = str(w.branch)?.replace(/^refs\/heads\//, '') ?? null
    const desk: Desk = {
      id: String(w.worktreeId ?? ''),
      name: str(w.displayName) ?? branch ?? 'workspace',
      branch,
      parentId: str(w.parentWorktreeId),
      staff: agents.map(toStaff)
    }
    const list = floors.get(repo) ?? []
    list.push(desk)
    floors.set(repo, list)
  }
  const out: Floor[] = [...floors.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, desks]) => ({ repo, desks }))
  return { at, floors: out, error: null }
}

function switchTerminal(paneKey: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      cliPath(),
      ['terminal', 'list', '--json'],
      { timeout: CLI_TIMEOUT_MS },
      (error, stdout) => {
        if (error || !stdout) return resolve(false)
        try {
          const data = JSON.parse(stdout)
          const terminals = (data as { result?: { terminals?: Row[] } })?.result?.terminals
          if (Array.isArray(terminals)) {
            const match = terminals.find((t) => {
              const tabId = String(t.tabId ?? '')
              const leafId = String(t.leafId ?? '')
              const key = `${tabId}:${leafId}`
              return key === paneKey || tabId === paneKey || leafId === paneKey
            })
            if (match && match.handle) {
              execFile(cliPath(), ['terminal', 'switch', '--terminal', String(match.handle)], (switchErr) => {
                resolve(!switchErr)
              })
              return
            }
          }
          resolve(false)
        } catch {
          resolve(false)
        }
      }
    )
  })
}

export default function activate(orca: OrcaWorkerApi): void {
  let last: OfficeSnapshot = { at: 0, floors: [], error: null }
  orca.panels.handle('office.snapshot', async () => {
    try {
      last = toSnapshot(await runPs(), Date.now())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      orca.log(`worktree ps failed: ${message}`)
      last = { ...last, error: message }
    }
    return last
  })
  orca.panels.handle('office.switch', async (input: unknown) => {
    const paneKey = (input as { paneKey?: string })?.paneKey
    if (!paneKey) return { ok: false }
    const ok = await switchTerminal(paneKey)
    return { ok }
  })
}
