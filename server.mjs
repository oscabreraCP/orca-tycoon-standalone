import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = 3456
const HOST = '127.0.0.1' // localhost only

const CLI_CANDIDATES = [
  '/Applications/Orca.app/Contents/Resources/bin/orca',
  `${process.env.HOME ?? ''}/Applications/Orca.app/Contents/Resources/bin/orca`
]

function cliPath() {
  return CLI_CANDIDATES.find((p) => fs.existsSync(p)) ?? 'orca'
}

function runPs() {
  return new Promise((resolve, reject) => {
    execFile(
      cliPath(),
      ['worktree', 'ps', '--json'],
      { timeout: 8000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error && !stdout) return reject(error)
        try {
          resolve(JSON.parse(stdout))
        } catch (e) {
          reject(e)
        }
      }
    )
  })
}

function switchTerminal(paneKey) {
  return new Promise((resolve) => {
    execFile(
      cliPath(),
      ['terminal', 'list', '--json'],
      { timeout: 8000 },
      (error, stdout) => {
        if (error || !stdout) return resolve(false)
        try {
          const data = JSON.parse(stdout)
          const terminals = data?.result?.terminals
          if (Array.isArray(terminals)) {
            const match = terminals.find((t) => {
              const tabId = String(t.tabId ?? '')
              const leafId = String(t.leafId ?? '')
              const key = `${tabId}:${leafId}`
              return key === paneKey || tabId === paneKey || leafId === paneKey
            })
            if (match && match.handle) {
              execFile(cliPath(), ['terminal', 'switch', '--terminal', String(match.handle)], (err) => {
                resolve(!err)
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

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

function staffState(row) {
  const state = row.state
  if (state === 'working') return row.workingMode === 'monitoring' ? 'monitoring' : 'working'
  if (state === 'waiting' || state === 'blocked' || state === 'done') return state
  return 'idle'
}

function specialistState(state) {
  if (state === 'working' || state === 'waiting' || state === 'blocked' || state === 'done') {
    return state
  }
  return 'idle'
}

function toStaff(row) {
  const subs = Array.isArray(row.subagents) ? row.subagents : []
  const specialists = subs.map((s) => ({
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

function toSnapshot(raw, at) {
  const result = raw?.result
  const worktrees = Array.isArray(result?.worktrees) ? result.worktrees : []
  const floors = new Map()
  for (const w of worktrees) {
    if (w.isArchived === true) continue
    const agents = Array.isArray(w.agents) ? w.agents : []
    if (agents.length === 0) continue
    const repo = str(w.repo) ?? 'Other'
    const branch = str(w.branch)?.replace(/^refs\/heads\//, '') ?? null
    const desk = {
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
  const out = [...floors.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, desks]) => ({ repo, desks }))
  return { at, floors: out, error: null }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8'
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)

  // API: Get snapshot
  if (url.pathname === '/api/snapshot' && req.method === 'GET') {
    try {
      const raw = await runPs()
      const snap = toSnapshot(raw, Date.now())
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(snap))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message }))
    }
    return
  }

  // API: Switch terminal
  if (url.pathname === '/api/switch' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      try {
        const { paneKey } = JSON.parse(body || '{}')
        const ok = paneKey ? await switchTerminal(paneKey) : false
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok }))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e.message }))
      }
    })
    return
  }

  // Static files
  let reqPath = url.pathname === '/' ? '/src/panel.html' : url.pathname
  let filePath = path.join(__dirname, reqPath.startsWith('/src/') ? reqPath : `/src/${reqPath}`)

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // Check root directory fallback (docs, etc)
    const altPath = path.join(__dirname, reqPath)
    if (fs.existsSync(altPath) && !fs.statSync(altPath).isDirectory()) {
      filePath = altPath
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
      return
    }
  }

  const ext = path.extname(filePath)
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' })
  fs.createReadStream(filePath).pipe(res)
})

server.listen(PORT, HOST, () => {
  console.log(`Orca Tycoon localhost server running at http://${HOST}:${PORT}`)
})
