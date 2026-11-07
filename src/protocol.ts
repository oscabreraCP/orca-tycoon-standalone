// The panel <-> worker contract, declared once: src/panel.js and src/worker.ts both read it.
export {}

export type StaffState = 'working' | 'monitoring' | 'waiting' | 'blocked' | 'done' | 'idle'

/** A subagent: a specialist the agent called in, seated on a stool at its desk. */
export type Specialist = {
  id: string
  role: string | null
  task: string | null
  state: StaffState
}

export type Staff = {
  id: string
  agent: string | null
  name: string | null
  task: string | null
  tool: string | null
  /** First line of the agent's last reply, for its speech bubble. */
  said: string | null
  state: StaffState
  since: number
  specialists: Specialist[]
}

export type Desk = {
  id: string
  name: string
  branch: string | null
  parentId: string | null
  staff: Staff[]
}

export type Floor = { repo: string; desks: Desk[] }

export type OfficeSnapshot = {
  at: number
  floors: Floor[]
  error: string | null
}

declare module 'orca' {
  interface PluginRequests {
    /** Every workspace with its agents and their subagents, grouped by project. */
    'office.snapshot': { output: OfficeSnapshot }
    /** Switch to the terminal tab corresponding to a staff's paneKey. */
    'office.switch': { input: { paneKey: string }; output: { ok: boolean } }
  }
}
