// Orca Tycoon: every agent on this Orca host as a little pixel worker on one office floor, with
// Palú, the office dog, wandering among them.
// Each project is an open area on the floor; every worktree in it is a seat at a shared desk, with a
// worktree's children seated next to it. Subagents are specialists: they come in through the
// front door, sit on a stool at the end of their agent's desk, and leave the same way.
// The worker answers 'office.snapshot' from `orca worktree ps`; this frame polls it every 3 s
// (the rate Orca's own phone app polls at).
//
// One canvas, never rebuilt: a poll swaps the data and the next frame draws it, so a refresh
// never blanks the screen.

import {
  C,
  SEAT_H,
  SEAT_W,
  STATE_LABEL,
  bookshelf,
  booth,
  boothGlass,
  coffeeMachine,
  desk,
  foosball,
  kitchen,
  lounger,
  lounge,
  painter,
  person,
  pick,
  roleColor,
  specialist,
  stool,
  plant,
  walker,
  paluWalk,
  paluWalkFront,
  paluWalkBack,
  paluSniff,
  dogBowls,
  paluSit,
  paluLie,
  dogBed,
  waterCooler,
  whiteboard,
  workstation
} from './sprites.js'

const POLL_MS = 3000
const FRAME_MS = 125
const BUBBLE_MS = 9000

// Geometry, in art pixels.
const OUTER = 4 // building wall
const MARGIN = 6 // floor between the building wall and the rooms
const GAP = 7 // corridor between rooms
const GLASS = 0 // open areas: no walls
const PAD = 4 // inside a room, between the glass and its furniture
const TOP = 13 // room name plaque and whiteboard
const LABEL_H = 5 // nameplate under each seat
const AISLE = 7 // walkway below each row of desks
const DESK_W = SEAT_W + 4 // one agent's desk
const STOOL_W = 9 // one stool at the end of a desk
const MAX_STOOLS = 3 // beyond this a desk shows +N
const LINE_H = SEAT_H + LABEL_H + AISLE
const TABLE_GAP = 6
const MIN_ROOM_W = (DESK_W + STOOL_W + 1) * 2 + PAD * 2 + GLASS * 2
const COMMON_H = 34
const WALK_SPEED = 1.5 // art pixels per frame
// States in which an agent leaves its desk for the coffee corner until the state ends.
// 'monitoring' is a finished turn waiting on background tasks; add 'waiting' to also send
// agents that wait for you.
const AWAY_STATES = new Set(['monitoring'])
// What an agent on a break can do. Each one draws an activity per period of its own (weighted,
// seeded by the agent and the period, so a reopened panel shows the same picture).
const ACTIVITIES = [
  { id: 'nap', kind: 'lounge', pose: 'nap', weight: 1.5, sleepyOnly: true },
  { id: 'sofa-coffee', kind: 'lounge', pose: 'coffee', weight: 1.5 },
  { id: 'read', kind: 'lounge', pose: 'read', weight: 1.5 },
  { id: 'coffee', kind: 'coffee', weight: 2 },
  { id: 'foosball', kind: 'foosball', weight: 3 },
  { id: 'call', kind: 'booth', weight: 2 }
]
const ACTIVITY_MS = 60000
// States in which an agent goes and naps on the lounge sofa, while there are seats.
const LOUNGE_STATES = new Set(['done', 'idle'])

const FLOOR = { plank: '#d9c8a4', seam: '#c9b78f', joint: '#bba97f' }
const BRICK = { wall: '#b5653f', top: '#cf7a50', dark: '#8f4b2d', window: '#a8d2e6' }
const CARPETS = ['#a98260', '#7f9b74', '#8d7f9c', '#7d8ba6', '#a8936f', '#9c7575', '#6f9a99']
const STATE_NOTE = {
  working: C.green,
  monitoring: C.blue,
  waiting: C.amber,
  blocked: C.red,
  done: '#9aa0b4',
  idle: '#9aa0b4'
}

const canvas = document.getElementById('plan')
const ctx = canvas.getContext('2d')

let snapshot = null
let layout = { artW: 0, artH: 0, scale: 3, building: null, rooms: [], seats: [], common: null }
let selected = null // seat key
let tick = 0
const lastState = new Map() // seat key -> state, to pop a bubble when it changes
const bubbles = new Map() // seat key -> { text, until }
const walkers = new Map() // seat key -> { x, y, path, mode: 'out' | 'away' | 'back' }
const visitors = new Map() // specialist key -> { spec, x, y, path, mode: 'in' | 'seated' | 'out' }
// False until the first snapshot has been placed. Whatever that snapshot shows is already true when
// the panel opens, so it is drawn in place; only changes seen after it are walked.
let scenePrimed = false
let primed = false

function since(ms) {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.round(m / 60)}h`
}

/** The short name on a seat's nameplate: the ticket key when there is one. */
function shortName(desk) {
  const key = desk.name.match(/[A-Z]{2,6}-\d+/)
  if (key) return key[0]
  return desk.name.split(/[\s/]+/)[0]
}

/** Rich label for a seat: prefers ticket, issue #, clean tab name, then branch. */
function seatLabel(seat) {
  const staff = seat.staff
  const desk = seat.desk
  const name = staff?.name || ''

  // 1. Ticket in tab name or desk: e.g. IT-73625
  const ticket = name.match(/[A-Z]{2,6}-\d+/) || desk.name.match(/[A-Z]{2,6}-\d+/)
  if (ticket) return ticket[0]

  // 2. Issue in tab name: e.g. Issue #19977 or #19977
  const issue = name.match(/(?:Issue\s*)?#(\d+)/i)
  if (issue) return `#${issue[1]}`

  // 3. Tab name clean up
  if (name.trim()) {
    const clean = name.replace(/^[^\w\s#]+/, '').trim()
    const words = clean.split(/\s+/)
    if (words[0]) {
      if (words[0].length <= 9) return words[0]
      return words[0].slice(0, 8) + '…'
    }
  }

  // 4. Fallback to branch/desk name
  return shortName(desk)
}

// ---- layout ----------------------------------------------------------------------------------

/** Root worktrees, each with all its descendants, so a family shares one desk. */
function families(desks) {
  const byId = new Map(desks.map((d) => [d.id, d]))
  const kids = new Map()
  const roots = []
  for (const d of desks) {
    if (d.parentId && byId.has(d.parentId)) {
      const list = kids.get(d.parentId) ?? []
      list.push(d)
      kids.set(d.parentId, list)
    } else roots.push(d)
  }
  const byName = (a, b) => a.name.localeCompare(b.name)
  const descend = (d) => [d, ...(kids.get(d.id) ?? []).sort(byName).flatMap(descend)]
  return roots.sort(byName).map(descend)
}

/** The seats of one family, parent first: one per agent in each worktree. */
function familySeats(family) {
  return family.flatMap((desk) =>
    [...desk.staff].sort((a, b) => a.id.localeCompare(b.id)).map((staff) => ({ desk, staff }))
  )
}

/** Specialists still at work: done ones have left. */
function activeSpecialists(staff) {
  return staff.specialists.filter((sp) => sp.state !== 'done' && sp.state !== 'idle').sort((a, b) => a.id.localeCompare(b.id))
}

/** An agent's desk plus its stools: always one free stool, up to MAX_STOOLS. */
function stoolCount(staff) {
  return Math.max(1, Math.min(MAX_STOOLS, activeSpecialists(staff).length))
}

function segmentW(seat) {
  return DESK_W + stoolCount(seat.staff) * STOOL_W + 1
}

/** Splits families into tables no wider than the room, then packs tables into lines. */
function planRoom(floor, innerW) {
  const tables = []
  for (const family of families(floor.desks)) {
    let table = []
    let width = 0
    for (const seat of familySeats(family)) {
      const w = segmentW(seat)
      if (table.length && width + w > innerW) {
        tables.push(table)
        table = []
        width = 0
      }
      table.push(seat)
      width += w
    }
    if (table.length) tables.push(table)
  }
  const tableW = (table) => table.reduce((n, seat) => n + segmentW(seat), 0)
  const lines = []
  let line = []
  let width = 0
  for (const table of tables) {
    const w = tableW(table)
    if (line.length && width + TABLE_GAP + w > innerW) {
      lines.push(line)
      line = []
      width = 0
    }
    width += (line.length ? TABLE_GAP : 0) + w
    line.push(table)
  }
  if (line.length) lines.push(line)
  return { lines, tableW }
}

function computeLayout() {
  const cssW = Math.max(180, document.getElementById('office').clientWidth)
  const scale = cssW >= 300 ? 3 : 2
  const artW = Math.floor(cssW / scale)
  const floorW = artW - OUTER * 2 - MARGIN * 2
  const cols = Math.max(1, Math.floor((floorW + GAP) / (MIN_ROOM_W + GAP)))
  const roomW = Math.floor((floorW - GAP * (cols - 1)) / cols)
  const innerW = roomW - GLASS * 2 - PAD * 2

  // Plan every area first, so the commons band can go where it splits the floor in two.
  // A team that would need three or more rows of desks in one column gets the whole floor width
  // instead, so it spreads across rather than down. Biggest teams go first.
  const fullInner = floorW - GLASS * 2 - PAD * 2
  const seatCount = (floor) => floor.desks.reduce((n, d) => n + d.staff.length, 0)
  const plans = (snapshot?.floors ?? [])
    .map((floor) => {
      let plan = { ...planRoom(floor, innerW), w: roomW, inner: innerW, wide: false }
      if (cols > 1 && plan.lines.length >= 3) plan = { ...planRoom(floor, fullInner), w: floorW, inner: fullInner, wide: true }
      return { floor, ...plan, h: TOP + plan.lines.length * LINE_H + PAD }
    })
    .sort((a, b) => seatCount(b.floor) - seatCount(a.floor) || a.floor.repo.localeCompare(b.floor.repo))
  // Open areas need not line up: each one goes into the column that is shortest so far, and a
  // full-width team starts below everything placed before it.
  const pack = (list, top) => {
    const colY = Array.from({ length: cols }, () => top)
    const placed = list.map((plan) => {
      if (plan.wide) {
        const y = Math.max(...colY)
        colY.fill(y + plan.h + GAP)
        return { plan, x: OUTER + MARGIN, y }
      }
      const col = colY.indexOf(Math.min(...colY))
      const at = { plan, x: OUTER + MARGIN + col * (roomW + GAP), y: colY[col] }
      colY[col] += plan.h + GAP
      return at
    })
    return { placed, bottom: Math.max(...colY) }
  }
  // Split the areas so the band lands as close to the middle as it can.
  let split = plans.length
  let best = Infinity
  for (let k = 1; k <= plans.length; k++) {
    const above = pack(plans.slice(0, k), 0).bottom
    const below = pack(plans.slice(k), 0).bottom
    if (Math.abs(above - below) < best) {
      best = Math.abs(above - below)
      split = k
    }
  }
  const top = pack(plans.slice(0, split), OUTER + MARGIN)

  // The commons band across the middle: lounge, coffee corner (water dispenser, coffee machine)
  // and kitchen. Wide floors put them side by side; narrow ones stack the lounge above.
  const wide = floorW >= 150
  const bandY = plans.length ? top.bottom : OUTER + MARGIN
  const rows = wide ? 2 : 3
  const bandH = COMMON_H * rows
  const gamesY = bandY + COMMON_H * (rows - 1)
  const entry = 10 // a clear strip by the door
  const common = { x: OUTER + MARGIN, y: bandY, w: floorW, h: bandH }
  const loungeW = wide ? Math.floor((floorW - GAP) / 2) - entry : floorW - entry
  const cornerX = wide ? common.x + entry + loungeW + GAP : common.x + entry
  const cornerY = wide ? bandY : bandY + COMMON_H
  common.lounge = { x: common.x + entry, y: bandY + 4, w: loungeW }
  common.cooler = { x: cornerX + 2, y: cornerY + 2 }
  common.coffee = { x: cornerX + 12, y: cornerY + 4 }
  common.kitchen = { x: cornerX + 24, y: cornerY + 6, w: Math.max(30, common.x + floorW - cornerX - 24) }
  common.laneTop = bandY - 4
  common.laneBottom = bandY + bandH - 8
  common.spots = []
  for (let sx = cornerX; sx + 8 <= common.x + floorW; sx += 9) common.spots.push({ x: sx, y: cornerY + 17, kind: 'coffee' })
  // the games row: a foosball table, and calling booths along the right
  const fx = common.x + entry + 12
  common.foosball = { x: fx, y: gamesY + 7 }
  // players stand on the long sides, where the rods stick out: one behind the table facing you,
  // one in front with their back to you
  common.foos = [
    { x: fx + 5, y: gamesY + 7 - 15, kind: 'foosball', left: false, back: false },
    { x: fx + 15, y: gamesY + 7 + 12, kind: 'foosball', left: false, back: true }
  ]
  common.booths = []
  const boothCount = wide ? 3 : 2
  for (let i = 0; i < boothCount; i++) {
    const bx = common.x + floorW - (i + 1) * 16
    common.booths.push({ x: bx + 2, y: gamesY + 9, kind: 'booth', left: true, bx, by: gamesY + 5 })
  }
  common.sofa = []
  const sofaSeats = Math.min(6, Math.floor((loungeW - 12) / 9))
  for (let i = 0; i < sofaSeats; i++) common.sofa.push({ x: common.lounge.x + 6 + i * 9, y: common.lounge.y + 1, kind: 'lounge' })
  // The front door is in the left wall, level with the band.
  const doorY = bandY + 8
  // Palú's bed: in the games row between the foosball table and the booths when it fits, else in
  // a corner of the lounge rug. His bowls go beside the bed when there is room for both, else in
  // the lounge's front corner by the door.
  const gapStart = fx + 34
  const gapEnd = common.x + floorW - boothCount * 16
  const gap = gapEnd - gapStart
  if (gap >= 48) {
    // bowls first, with room on their left to stand clear of the foosball table, then the bed
    common.bowls = { x: gapStart + 8 + Math.floor((gap - 48) / 2), y: gamesY + 18 }
    common.bed = { x: common.bowls.x + 16, y: gamesY + 14 }
  } else {
    common.bed =
      gap >= 30
        ? { x: gapStart + Math.floor((gap - 24) / 2), y: gamesY + 14 }
        : { x: common.lounge.x + common.lounge.w - 27, y: common.lounge.y + 16 }
    common.bowls = { x: common.lounge.x + 3, y: common.lounge.y + 19 }
  }

  const bottom = pack(plans.slice(split), bandY + bandH + GAP)
  const rooms = []
  const seats = []
  for (const { plan, x, y: ry } of [...top.placed, ...bottom.placed]) {
    const { floor, lines, tableW, h } = plan
    const room = { x, y: ry, w: plan.w, h, name: floor.repo, carpet: pick(CARPETS, floor.repo), notes: [] }
    lines.forEach((line, li) => {
      const lineW = line.reduce((n, t) => n + tableW(t), 0) + TABLE_GAP * (line.length - 1)
      let tx = room.x + GLASS + PAD + Math.floor((plan.inner - lineW) / 2)
      const ty = room.y + TOP + li * LINE_H
      for (const table of line) {
        for (const { desk: d, staff } of table) {
          const n = stoolCount(staff)
          const stools = Array.from({ length: n }, (_, i) => ({ x: tx + DESK_W + 1 + i * STOOL_W, y: ty + 19 }))
          const overflow = Math.max(0, activeSpecialists(staff).length - MAX_STOOLS)
          seats.push({ key: `${d.id}|${staff.id}`, x: tx + 2, y: ty, desk: d, staff, room, stools, overflow })
          room.notes.push(STATE_NOTE[staff.state])
          tx += DESK_W + n * STOOL_W + 1
        }
        tx += TABLE_GAP
      }
    })
    rooms.push(room)
  }
  const y = Math.max(bottom.bottom, bandY + bandH + GAP) - GAP + MARGIN
  const building = { w: artW, h: y + OUTER, doorY }
  return { artW, artH: building.h, scale, building, rooms, seats, common }
}

function resize() {
  layout = computeLayout()
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(layout.artW * layout.scale * dpr)
  const h = Math.round(layout.artH * layout.scale * dpr)
  // Only touch the size when it changes: assigning it clears the canvas.
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
    canvas.style.width = `${layout.artW * layout.scale}px`
    canvas.style.height = `${layout.artH * layout.scale}px`
  }
  draw()
}

// ---- drawing ---------------------------------------------------------------------------------

function artTransform() {
  const k = layout.scale * (window.devicePixelRatio || 1)
  ctx.setTransform(k, 0, 0, k, 0, 0)
  ctx.imageSmoothingEnabled = false
}

function cssTransform() {
  const d = window.devicePixelRatio || 1
  ctx.setTransform(d, 0, 0, d, 0, 0)
}

function drawBuilding(p) {
  const { w, h } = layout.building
  p(0, 0, w, h, BRICK.wall)
  p(0, 0, w, 1, BRICK.top)
  p(0, h - 1, w, 1, BRICK.dark)
  // floorboards
  p(OUTER, OUTER, w - OUTER * 2, h - OUTER * 2, FLOOR.plank)
  for (let y = OUTER + 3; y < h - OUTER; y += 4) {
    p(OUTER, y, w - OUTER * 2, 1, FLOOR.seam)
    const offset = ((y >> 2) * 13) % 24
    for (let x = OUTER + offset; x < w - OUTER; x += 24) p(x, y - 3, 1, 3, FLOOR.joint)
  }
  // front door in the left wall, level with the commons band, with a doormat
  const dy = layout.building.doorY
  p(0, dy - 2, OUTER, 19, FLOOR.plank)
  p(0, dy - 3, OUTER, 1, BRICK.dark)
  p(0, dy + 17, OUTER, 1, BRICK.dark)
  p(OUTER, dy + 1, 3, 14, '#7a4f3a')
  // windows in the top wall, light falling in
  for (let x = 14; x + 12 < w - 8; x += 40) {
    p(x, 0, 12, 3, BRICK.window)
    p(x + 5, 0, 1, 3, '#dceff7')
  }
}

function drawRoom(p, room) {
  const { x, y, w, h } = room
  // An area rug with rounded corners and a darker rim, so the zone reads without walls.
  p(x + 2, y, w - 4, h, room.carpet)
  p(x, y + 2, w, h - 4, room.carpet)
  p(x + 1, y + 1, w - 2, h - 2, room.carpet)
  p(x + 3, y + 2, w - 6, 1, 'rgba(255,255,255,0.10)')
  p(x + 2, y + h - 1, w - 4, 1, 'rgba(0,0,0,0.18)')
  p(x + w - 1, y + 2, 1, h - 4, 'rgba(0,0,0,0.12)')
  // speckle so the carpet reads as fabric
  for (let i = 0; i < (w * h) / 40; i++) {
    const sx = x + 2 + ((i * 37) % (w - 4))
    const sy = y + 2 + ((i * 53) % (h - 4))
    p(sx, sy, 1, 1, 'rgba(255,255,255,0.08)')
  }
  // name plaque and a whiteboard of sticky notes; the plant and bookshelf stand on the floor and
  // are drawn with the scenery, in depth order
  p(x + 3, y + 3, Math.min(w - 40, 56), 7, '#2a2633')
  const boardW = Math.min(26, w - 70)
  if (boardW > 8) whiteboard(painter(ctx, x + w - boardW - 4, y + 3), boardW, room.notes)
}

/** Where an area's plant (7 x 9) and bookshelf (12 x 9, roomy areas only) stand. */
function roomDecor(room) {
  const { x, y, w, h } = room
  const decor = [{ kind: 'plant', x: x + 3, y: y + h - 11 }]
  if (w > 90 && h > 50) decor.push({ kind: 'bookshelf', x: x + w - 15, y: y + h - 12 })
  return decor
}

/** Everything standing on the floor, each with the box it covers and the row its base is on. */
function commonItems(c) {
  const decor = layout.rooms.flatMap(roomDecor).map((d) =>
    d.kind === 'plant'
      ? { box: [d.x, d.y, 7, 9], base: d.y + 9, draw: () => plant(painter(ctx, d.x, d.y)) }
      : { box: [d.x, d.y, 12, 9], base: d.y + 9, draw: () => bookshelf(painter(ctx, d.x, d.y)) }
  )
  if (!c) return decor.sort((a, b) => a.base - b.base)
  const playing = [...walkers.values()].filter((w) => w.mode === 'away' && w.activity?.kind === 'foosball').length >= 2
  const { lounge: l, kitchen: k, foosball: f, cooler, coffee, bowls } = c
  return [
    { box: [bowls.x, bowls.y, 13, 4], base: bowls.y + 4, draw: () => dogBowls(painter(ctx, bowls.x, bowls.y), tick) },
    { box: [l.x, l.y, l.w, 26], base: l.y + 14, draw: () => lounge(painter(ctx, l.x, l.y), l.w) },
    { box: [k.x, k.y - 6, k.w, 18], base: k.y + 12, draw: () => kitchen(painter(ctx, k.x, k.y), k.w) },
    ...c.booths.map((b) => ({ box: [b.bx, b.by, 13, 24], base: b.by + 24, draw: () => booth(painter(ctx, b.bx, b.by)) })),
    { box: [f.x - 2, f.y - 2, 32, 18], base: f.y + 14, draw: () => foosball(painter(ctx, f.x, f.y), tick, playing) },
    { box: [cooler.x, cooler.y, 7, 16], base: cooler.y + 16, draw: () => waterCooler(painter(ctx, cooler.x, cooler.y), tick) },
    { box: [coffee.x, coffee.y, 9, 14], base: coffee.y + 14, draw: () => coffeeMachine(painter(ctx, coffee.x, coffee.y), tick) },
    ...decor
  ].sort((a, b) => a.base - b.base)
}

const overlaps = ([ax, ay, aw, ah], [bx, by, bw, bh]) => ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah

/** Palú and everyone walking, each with the box they cover and the row their feet are on. */
function movers() {
  const list = []
  const person = (id, x, y, draw) => {
    const at = painter(ctx, Math.round(x), Math.round(y))
    list.push({ id, box: [Math.round(x), Math.round(y) - 1, 8, 16], base: Math.round(y) + 15, draw: () => draw(at) })
  }
  for (const seat of layout.seats) {
    const w = walkers.get(seat.key)
    if (w?.path.length) person(seat.key, w.x, w.y, (at) => walker(at, seat.staff, tick, true, w.left))
  }
  for (const [key, v] of visitors) {
    if (v.mode !== 'seated' && !(v.wait > 0)) person(key, v.x, v.y, (at) => walker(at, v.spec, tick, true, v.left, roleColor(v.spec.role)))
  }
  const dog = paluBox()
  if (dog) list.push({ id: 'palu', ...dog, draw: drawPalu })
  return list.sort((a, b) => a.base - b.base)
}

/** Draws the commons; returns who was drawn among the furniture, behind something. */
function drawCommon() {
  const c = layout.common
  // his bed is on the floor, under everything
  if (c) dogBed(painter(ctx, c.bed.x, c.bed.y))
  const items = commonItems(c)
  const before = new Map() // item -> who passes just behind it
  for (const m of movers()) {
    const inFront = items.find((i) => i.base > m.base && overlaps(i.box, m.box))
    if (inFront) before.set(inFront, [...(before.get(inFront) ?? []), m])
  }
  const behind = new Set()
  for (const item of items) {
    for (const m of before.get(item) ?? []) {
      m.draw()
      behind.add(m.id)
    }
    item.draw()
  }
  return behind
}

// ---- walking to the coffee corner ------------------------------------------------------------

/** Where an agent stands when it gets up: the aisle in front of its seat. */
function homeOf(seat) {
  return { x: seat.x + 6, y: seat.y + SEAT_H + LABEL_H - 4 }
}

/** From where someone is to `to`, around the desks and furniture in the way. */
function walkPath(from, to) {
  return floorRoute(from, to, 'people') ?? [{ x: to.x, y: to.y }]
}

function hashOf(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  // FNV alone barely moves when only the last character differs; mix the bits so draws are independent
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const activityOf = new Map() // seat key -> activity id, for drawing the right pose

// Each agent on a break keeps its activity for its own period (45 to 90 s, from its own offset),
// so they change one at a time, and keeps its spot until then, so nobody else is shuffled.
const assigned = new Map() // seat key -> { slot, a, kind, index }

function slotOf(key, now) {
  const period = ACTIVITY_MS * (0.75 + 0.75 * hashOf(`${key}|period`))
  const offset = hashOf(`${key}|offset`) * period
  return Math.floor((now + offset) / period)
}

/** The spot for every agent on a break; full places pass on, nobody plays foosball alone. */
function assignBreaks(common) {
  const now = Date.now()
  const pools = { lounge: common.sofa, coffee: common.spots, foosball: common.foos, booth: common.booths }
  const onBreak = layout.seats.filter((s) => AWAY_STATES.has(s.staff.state) || LOUNGE_STATES.has(s.staff.state))
  const onKeys = new Set(onBreak.map((s) => s.key))
  for (const key of assigned.keys()) if (!onKeys.has(key)) assigned.delete(key)

  const taken = { lounge: new Set(), coffee: new Set(), foosball: new Set(), booth: new Set() }
  const pending = []
  for (const seat of onBreak) {
    const slot = slotOf(seat.key, now)
    const sleepy = LOUNGE_STATES.has(seat.staff.state)
    const e = assigned.get(seat.key)
    const keep = e && e.slot === slot && e.index < pools[e.kind].length && (sleepy || !e.a.sleepyOnly) && !taken[e.kind].has(e.index)
    if (keep) taken[e.kind].add(e.index)
    else {
      assigned.delete(seat.key)
      pending.push({ seat, slot, sleepy })
    }
  }
  const ranked = ({ seat, slot, sleepy }) =>
    ACTIVITIES.filter((a) => sleepy || !a.sleepyOnly)
      .map((a, i) => ({ a, score: -Math.log(1e-9 + hashOf(`${seat.key}|${slot}|${i}`)) / a.weight }))
      .sort((x, y) => x.score - y.score)
      .map((r) => r.a)
  const place = (p, skip) => {
    for (const a of ranked(p)) {
      if (a.kind === skip) continue
      const index = pools[a.kind].findIndex((_, i) => !taken[a.kind].has(i))
      if (index >= 0) {
        taken[a.kind].add(index)
        assigned.set(p.seat.key, { slot: p.slot, a, kind: a.kind, index })
        return
      }
    }
  }
  pending.sort((x, y) => hashOf(`${x.seat.key}|${x.slot}|turn`) - hashOf(`${y.seat.key}|${y.slot}|turn`))
  for (const p of pending) place(p, null)
  // Nobody plays foosball alone: a lone player picks something else.
  const players = [...assigned].filter(([, e]) => e.kind === 'foosball')
  if (players.length === 1) {
    const [key, e] = players[0]
    assigned.delete(key)
    taken.foosball.delete(e.index)
    const seat = onBreak.find((s) => s.key === key)
    place({ seat, slot: e.slot, sleepy: LOUNGE_STATES.has(seat.staff.state) }, 'foosball')
  }

  activityOf.clear()
  const spotOf = new Map()
  for (const [key, e] of assigned) {
    spotOf.set(key, pools[e.kind][e.index])
    activityOf.set(key, e.a)
  }
  return spotOf
}

function stepWalkers() {
  const common = layout.common
  if (!common) return
  const spotOf = assignBreaks(common)
  const live = new Set(layout.seats.map((s) => s.key))
  for (const key of walkers.keys()) if (!live.has(key)) walkers.delete(key)

  for (const seat of layout.seats) {
    const spot = spotOf.get(seat.key)
    let w = walkers.get(seat.key)
    const activity = activityOf.get(seat.key) ?? null
    if (w) w.activity = activity
    if (spot && !w && !scenePrimed) {
      // already on a break when the panel opened
      w = { x: spot.x, y: spot.y, path: [], mode: 'away', spot, activity, left: spot.left }
      walkers.set(seat.key, w)
    } else if (spot && !w) {
      const home = homeOf(seat)
      w = { ...home, path: walkPath(home, spot), mode: 'out', spot, activity }
      walkers.set(seat.key, w)
    } else if (spot && w && w.mode !== 'back' && (w.spot.x !== spot.x || w.spot.y !== spot.y)) {
      // a new spot in the band (the corner reshuffled, or coffee turned into a nap)
      w.path = walkPath(w, spot)
      w.mode = 'out'
      w.spot = spot
    } else if (spot && w && w.mode === 'back') {
      w.path = walkPath(w, spot)
      w.mode = 'out'
      w.spot = spot
    } else if (!spot && w && w.mode !== 'back') {
      w.path = walkPath(w, homeOf(seat))
      w.mode = 'back'
    }
    if (!w) continue
    const next = w.path[0]
    if (next) {
      const dx = next.x - w.x
      const dy = next.y - w.y
      w.left = dx < 0 ? true : dx > 0 ? false : w.left
      w.x += Math.max(-WALK_SPEED, Math.min(WALK_SPEED, dx))
      w.y += Math.max(-WALK_SPEED, Math.min(WALK_SPEED, dy))
      if (Math.abs(next.x - w.x) < 0.5 && Math.abs(next.y - w.y) < 0.5) {
        w.x = next.x
        w.y = next.y
        w.path.shift()
      }
    } else if (w.mode === 'out') {
      w.mode = 'away'
      w.left = w.spot.left ?? false
    } else if (w.mode === 'back') {
      walkers.delete(seat.key)
    }
  }
}

// ---- specialists coming and going -------------------------------------------------------------

const DOOR_LANE_X = OUTER + 1

/** Where a specialist waits in the aisle before stepping onto the stool, and the stool itself. */
function stoolStops(seat, stoolAt) {
  return { aisle: { x: stoolAt.x - 1, y: seat.y + SEAT_H + LABEL_H - 8 }, on: { x: stoolAt.x - 1, y: seat.y + 6 } }
}

const doorStep = () => ({ x: DOOR_LANE_X, y: layout.building.doorY })

/** To the stool, from wherever they are; from outside, through the front door first. */
function routeIn(v, seat, stoolAt) {
  const { aisle, on } = stoolStops(seat, stoolAt)
  const from = v.x < DOOR_LANE_X ? doorStep() : v
  return [...(from === v ? [] : [from]), ...walkPath(from, aisle), on]
}

/** Off the stool into the aisle, across the floor to the front door, and out. */
function routeOut(v) {
  const door = doorStep()
  const from = v.mode === 'seated' ? v.aisle : v
  return [...(from === v ? [] : [from]), ...walkPath(from, door), { x: -10, y: door.y }]
}

function stepVisitors() {
  if (!layout.common || !layout.building) return
  const wanted = new Map()
  for (const seat of layout.seats) {
    activeSpecialists(seat.staff)
      .slice(0, MAX_STOOLS)
      .forEach((spec, i) => wanted.set(`${seat.key}|${spec.id}`, { seat, spec, stoolAt: seat.stools[i] }))
  }
  for (const [key, { seat, spec, stoolAt }] of wanted) {
    let v = visitors.get(key)
    const stops = stoolStops(seat, stoolAt)
    if (!v) {
      // Already here when the panel opened: seated straight away. Later arrivals walk in.
      // Several arriving together come through the door one after another.
      const queued = [...visitors.values()].filter((o) => o.mode === 'in' && o.x < DOOR_LANE_X).length
      const outside = { x: -8, y: layout.building.doorY }
      v = scenePrimed
        ? { spec, ...outside, path: routeIn(outside, seat, stoolAt), mode: 'in', aisle: stops.aisle, stoolAt, wait: queued * 10 }
        : { spec, ...stops.on, path: [], mode: 'seated', aisle: stops.aisle, stoolAt }
      visitors.set(key, v)
      continue
    }
    v.spec = spec
    v.aisle = stops.aisle
    if (v.mode === 'out') {
      // called back in before reaching the door
      v.path = routeIn(v, seat, stoolAt)
      v.mode = 'in'
    } else if (v.stoolAt.x !== stoolAt.x || v.stoolAt.y !== stoolAt.y) {
      // the desk moved (a stool was added or taken away): keep walking, to the new stool
      if (v.mode === 'seated') Object.assign(v, stops.on)
      else v.path = routeIn(v, seat, stoolAt)
    }
    v.stoolAt = stoolAt
  }
  for (const [key, v] of visitors) {
    if (!wanted.has(key) && v.mode !== 'out') {
      v.path = routeOut(v)
      v.mode = 'out'
      v.wait = 0
    }
    if (v.wait > 0) {
      v.wait--
      continue
    }
    const next = v.path[0]
    if (next) {
      const dx = next.x - v.x
      const dy = next.y - v.y
      v.left = dx < 0 ? true : dx > 0 ? false : v.left
      v.x += Math.max(-WALK_SPEED, Math.min(WALK_SPEED, dx))
      v.y += Math.max(-WALK_SPEED, Math.min(WALK_SPEED, dy))
      if (Math.abs(next.x - v.x) < 0.5 && Math.abs(next.y - v.y) < 0.5) {
        v.x = next.x
        v.y = next.y
        v.path.shift()
      }
    } else if (v.mode === 'in') v.mode = 'seated'
    else if (v.mode === 'out') visitors.delete(key)
  }
}

// ---- Palú, the office dog ----------------------------------------------------------------------
// Purely for company: he never takes a seat or changes what anyone does. Mostly he wanders the
// floor; now and then he naps in his bed, or lies down at someone's desk and naps there a while,
// more often beside someone who is dozing too.

const PALU_SPEED = 1
const PALU_AISLE = 3
let palu = null

const between = (lo, hi) => lo + Math.random() * (hi - lo)

function paluBedSpot() {
  const b = layout.common.bed
  return { x: b.x + 3, y: b.y + 1 }
}

/** Where he lies when visiting a desk: on the floor in front of it, below the nameplate. */
function paluDeskSpot(seat) {
  return { x: seat.x + 1, y: seat.y + SEAT_H + LABEL_H }
}

/** His two lanes: the top one runs just behind the commons furniture, the bottom one in front. */
function paluLanes() {
  const c = layout.common
  return [c.laneTop, c.laneBottom + 6]
}

// ---- finding the way across the floor ---------------------------------------------------------
// Everyone walks the open floor: a grid search over where their feet may go, around the floor
// space each desk and piece of furniture stands on. They may pass behind things (depth order
// draws them behind), never through them.

const GRID = 2
const TURN_COST = 10 // what a turn costs, in steps: long straight runs read as walking with purpose
const BLOCKED_COST = 1000

/** Where the feet are at (x, y): Palú side-on or up and down (narrower), and a person. */
const FEET = {
  palu: { side: (x, y) => [x + 1, y + 6, 16, 3], upright: (x, y) => [x + 5, y + 6, 8, 3] },
  people: { side: (x, y) => [x + 1, y + 12, 6, 3], upright: (x, y) => [x + 1, y + 12, 6, 3] }
}

/** The floor each obstacle stands on: [x, y, w, h], in art pixels. */
function floorObstacles(who) {
  const c = layout.common
  // a person in the aisle stands tall, feet level with the heads of the next row down: for them
  // a desk starts a little lower
  const top = who === 'people' ? 5 : 0
  const boxes = layout.seats.map((s) => [s.x - 2, s.y + top, DESK_W + s.stools.length * STOOL_W + 2, SEAT_H + LABEL_H - top])
  for (const d of layout.rooms.flatMap(roomDecor)) {
    boxes.push(d.kind === 'plant' ? [d.x + 1, d.y + 5, 5, 4] : [d.x, d.y + 4, 12, 5])
  }
  // each area's name plaque and whiteboard: walk in front of them, not over them
  for (const { x, y, w } of layout.rooms) {
    const boardW = Math.min(26, w - 70)
    boxes.push([x + 3, y + 3, Math.min(w - 40, 56), 7])
    if (boardW > 8) boxes.push([x + w - boardW - 4, y + 3, boardW, 7])
  }
  if (!c) return boxes
  const { lounge: l, kitchen: k, foosball: f, cooler, coffee } = c
  const mid = l.x + Math.floor(l.w / 2)
  boxes.push(
    [l.x + 2, l.y + 3, l.w - 4, 11], // the sofa
    [mid - 8, l.y + 17, 16, 4], // the coffee table
    [k.x, k.y + 4, k.w, 8], // the counter and the fridge
    [cooler.x, cooler.y + 10, 7, 6],
    [coffee.x, coffee.y + 8, 9, 6],
    [f.x, f.y, 28, 14],
    [c.bowls.x, c.bowls.y + 1, 13, 3],
    ...c.booths.map((b) => [b.bx, b.by + 6, 13, 18])
  )
  return boxes
}

function floorClear(box, blocks) {
  const [x, y, w, h] = box
  const inside = x >= OUTER && y >= OUTER && x + w <= layout.artW - OUTER && y + h <= layout.building.h - OUTER
  return inside && !blocks.some((b) => overlaps(b, box))
}

/**
 * Places worth a sniff: beside each plant and bookshelf, and at the ends and corners of the commons
 * furniture. Each is where he stands, side-on, with his nose just touching the thing.
 */
function paluSniffSpots() {
  const c = layout.common
  // nose to the left of him touching x (facing left), or to the right (facing right); paws on row y
  const fromRight = (x, base) => ({ x, y: base - 9, left: true })
  const fromLeft = (x, base) => ({ x: x - 18, y: base - 9, left: false })
  const spots = []
  for (const d of layout.rooms.flatMap(roomDecor)) {
    if (d.kind === 'plant') spots.push(fromRight(d.x + 7, d.y + 9))
    else spots.push(fromLeft(d.x, d.y + 9))
  }
  if (c) {
    const { lounge: l, kitchen: k, foosball: f, cooler, coffee } = c
    spots.push(
      fromLeft(l.x + 2, l.y + 14), // the sofa's arms
      fromRight(l.x + l.w - 2, l.y + 14),
      fromLeft(cooler.x, cooler.y + 16),
      fromRight(coffee.x + 9, coffee.y + 14),
      fromLeft(k.x, k.y + 12), // the end of the kitchen counter
      fromLeft(f.x, f.y + 14), // the foosball table's legs
      fromRight(f.x + 28, f.y + 14),
      ...c.booths.slice(-1).map((b) => fromLeft(b.bx, b.by + 24))
    )
  }
  const blocks = floorObstacles('palu')
  return spots.filter((s) => floorClear(FEET.palu.side(s.x, s.y), blocks))
}

const grids = new WeakMap() // layout -> where Palú's and people's feet may go, side-on and upright

function floorGrid(who) {
  let mine = grids.get(layout)
  if (!mine) grids.set(layout, (mine = {}))
  if (mine[who]) return mine[who]
  const G = GRID
  const W = Math.ceil(layout.artW / G)
  const H = Math.ceil(layout.building.h / G)
  const blocks = floorObstacles(who)
  const feet = FEET[who]
  const side = new Uint8Array(W * H)
  const upright = new Uint8Array(W * H)
  for (let gy = 0; gy < H; gy++) {
    for (let gx = 0; gx < W; gx++) {
      side[gy * W + gx] = floorClear(feet.side(gx * G, gy * G), blocks) ? 1 : 0
      upright[gy * W + gx] = floorClear(feet.upright(gx * G, gy * G), blocks) ? 1 : 0
    }
  }
  return (mine[who] = { W, H, side, upright })
}

/** Waypoints from `from` to `to`, around everything in the way. */
function floorRoute(from, to, who) {
  const G = GRID
  const { W, H, side, upright } = floorGrid(who)
  const snap = (v, n) => Math.max(0, Math.min(n - 1, Math.round(v / G)))
  const start = snap(from.y, H) * W + snap(from.x, W)
  const goal = snap(to.y, H) * W + snap(to.x, W)
  // Dijkstra over (cell, heading); headings 0,1 move along x, 2,3 along y
  const STEP = [1, -1, W, -W]
  const cost = new Float64Array(W * H * 4).fill(Infinity)
  const prev = new Int32Array(W * H * 4).fill(-1)
  const heap = []
  const push = (d, node) => {
    heap.push([d, node])
    for (let i = heap.length - 1; i > 0; ) {
      const j = (i - 1) >> 1
      if (heap[j][0] <= heap[i][0]) break
      ;[heap[i], heap[j]] = [heap[j], heap[i]]
      i = j
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop()
    if (heap.length) {
      heap[0] = last
      for (let i = 0; ; ) {
        const a = 2 * i + 1
        const b = a + 1
        let m = i
        if (a < heap.length && heap[a][0] < heap[m][0]) m = a
        if (b < heap.length && heap[b][0] < heap[m][0]) m = b
        if (m === i) break
        ;[heap[i], heap[m]] = [heap[m], heap[i]]
        i = m
      }
    }
    return top
  }
  for (let h = 0; h < 4; h++) {
    cost[start * 4 + h] = 0
    push(0, start * 4 + h)
  }
  let end = -1
  while (heap.length) {
    const [d, node] = pop()
    if (d > cost[node]) continue
    const cell = node >> 2
    if (cell === goal) {
      end = node
      break
    }
    const heading = node & 3
    const cx = cell % W
    for (let h = 0; h < 4; h++) {
      const next = cell + STEP[h]
      if (h < 2 ? Math.floor(next / W) !== Math.floor(cell / W) : next < 0 || next >= W * H) continue
      if (h === 0 && cx === W - 1) continue
      // a blocked step is not a wall, only very dear: he can always get out of a snug spot (his
      // nap by a desk, a seat on the sofa), but never cuts through furniture while there is a way round
      const free = h < 2 ? side : upright
      const nd = d + (free[next] ? 1 : BLOCKED_COST) + (h === heading ? 0 : TURN_COST)
      const key = next * 4 + h
      if (nd < cost[key]) {
        cost[key] = nd
        prev[key] = node
        push(nd, key)
      }
    }
  }
  if (end < 0) return null
  // walk back, keeping only the corners
  const cells = []
  for (let node = end; node >= 0; node = prev[node]) cells.push(node >> 2)
  cells.reverse()
  const points = cells.map((cell) => ({ x: (cell % W) * G, y: Math.floor(cell / W) * G }))
  // from the nearest cell, so the first leg runs along a row that is clear
  const corners = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const n = points[i + 1]
    if (!n || (a.x === b.x) !== (b.x === n.x)) corners.push(b)
  }
  corners.push({ x: to.x, y: to.y })
  return corners
}

/** To `to`; desk visits come along the aisle and shuffle the last pixels into the spot. */
function paluPath(to, viaAisle = false) {
  if (!viaAisle) return floorRoute(palu, to, 'palu')
  const path = floorRoute(palu, { x: to.x, y: to.y - PALU_AISLE }, 'palu')
  return path && [...path, { x: to.x, y: to.y }]
}

/** Where he stands to eat (nose in the kibble, from the left) or drink (from the right). */
function paluBowlSpots() {
  const b = layout.common.bowls
  const spots = [
    { x: b.x + 2 - 17, y: b.y + 3 - 9, left: false },
    { x: b.x + 10, y: b.y + 3 - 9, left: true }
  ]
  const blocks = floorObstacles('palu').filter((o) => !(o[0] === b.x && o[1] === b.y + 1))
  const clear = spots.filter((s) => floorClear(FEET.palu.side(s.x, s.y), blocks))
  return clear.length ? clear : spots.slice(0, 1)
}

function paluNext() {
  const atDesk = layout.seats.filter((s) => !walkers.has(s.key))
  const sniffs = paluSniffSpots()
  const options = [{ act: 'wander', w: 2 }, { act: 'bed', w: 1 }, { act: 'eat', w: 1 }]
  if (sniffs.length) options.push({ act: 'sniff', w: 3 })
  if (atDesk.length) options.push({ act: 'visit', w: 2 })
  let r = Math.random() * options.reduce((n, o) => n + o.w, 0)
  const act = options.find((o) => (r -= o.w) < 0)?.act ?? 'wander'
  palu.act = act
  palu.seatKey = null
  palu.restLeft = Math.random() < 0.5
  let path = null
  if (act === 'bed') {
    path = paluPath(paluBedSpot())
    palu.restFor = between(40000, 90000)
  } else if (act === 'sniff') {
    const spot = sniffs[Math.floor(Math.random() * sniffs.length)]
    path = paluPath(spot)
    palu.restLeft = spot.left
    palu.restFor = between(2500, 6000)
  } else if (act === 'eat') {
    const bowls = paluBowlSpots()
    const spot = bowls[Math.floor(Math.random() * bowls.length)]
    path = paluPath(spot)
    palu.restLeft = spot.left
    palu.restFor = between(3000, 7000)
  } else if (act === 'visit') {
    // more often beside someone dozing
    const weights = atDesk.map((s) => (LOUNGE_STATES.has(s.staff.state) ? 3 : 1))
    let q = Math.random() * weights.reduce((n, w) => n + w, 0)
    const seat = atDesk.find((_, i) => (q -= weights[i]) < 0) ?? atDesk[0]
    palu.seatKey = seat.key
    path = paluPath(paluDeskSpot(seat), true)
    palu.restFor = between(60000, 120000)
  } else {
    for (let tries = 0; tries < 6 && !path; tries++) {
      const x = Math.round(between(OUTER + 4, layout.artW - OUTER - 22))
      const y = paluLanes()[Math.random() < 0.5 ? 0 : 1]
      path = paluPath({ x, y })
    }
    palu.restFor = between(3000, 8000)
  }
  // nowhere he can get to: a short sit where he is, then he thinks again
  if (!path) {
    palu.act = 'wander'
    palu.seatKey = null
    palu.restFor = between(3000, 8000)
  }
  palu.path = path ?? []
  palu.until = null
}

function stepPalu() {
  if (!layout.common) return
  const now = Date.now()
  if (!palu) {
    // the panel opens with him asleep in his bed
    const spot = paluBedSpot()
    palu = { ...spot, path: [], act: 'bed', until: now + between(20000, 60000), restLeft: false }
  }
  const next = palu.path[0]
  if (next) {
    const dx = next.x - palu.x
    const dy = next.y - palu.y
    if (Math.abs(dx) >= 0.5) {
      palu.left = dx < 0
      palu.dir = 'side'
    } else if (Math.abs(dy) > PALU_AISLE) palu.dir = dy > 0 ? 'down' : 'up'
    // the little step between the aisle and his spot is a shuffle, not a turn
    palu.x += Math.max(-PALU_SPEED, Math.min(PALU_SPEED, dx))
    palu.y += Math.max(-PALU_SPEED, Math.min(PALU_SPEED, dy))
    if (Math.abs(next.x - palu.x) < 0.5 && Math.abs(next.y - palu.y) < 0.5) {
      palu.x = next.x
      palu.y = next.y
      palu.path.shift()
    }
    return
  }
  if (palu.until === null) palu.until = now + palu.restFor
  // stay put on his spot even if the floor shifted under him
  const seat = palu.seatKey ? layout.seats.find((s) => s.key === palu.seatKey) : null
  if (palu.act === 'bed') Object.assign(palu, paluBedSpot())
  else if (seat) Object.assign(palu, paluDeskSpot(seat))
  // time to move on, or the person he was napping beside got up
  const leftDesk = palu.act === 'visit' && (!seat || walkers.has(seat.key))
  if (now >= palu.until || leftDesk) paluNext()
}

/** The box Palú covers and the row his paws are on, for drawing him behind furniture. */
function paluBox() {
  if (!palu) return null
  const x = Math.round(palu.x)
  const y = Math.round(palu.y)
  if (palu.path.length && palu.dir !== 'side') return { box: [x + 5, y - 2, 8, 11], base: y + 9 }
  if (palu.path.length) return { box: [x, y - 1, 18, 10], base: y + 9 }
  if (palu.act === 'sniff' || palu.act === 'eat') return { box: [x, y - 1, 18, 10], base: y + 9 }
  if (palu.act === 'wander') return { box: [x + 5, y - 3, 8, 10], base: y + 7 }
  return { box: [x, y, 18, 6], base: y + 6 }
}

function drawPalu() {
  if (!palu) return
  const at = painter(ctx, Math.round(palu.x), Math.round(palu.y))
  const upright = painter(ctx, Math.round(palu.x) + 4, Math.round(palu.y) - 1)
  if (palu.path.length && palu.dir === 'down') paluWalkFront(upright, tick)
  else if (palu.path.length && palu.dir === 'up') paluWalkBack(upright, tick)
  else if (palu.path.length) paluWalk(at, tick, palu.left)
  else if (palu.act === 'sniff' || palu.act === 'eat') paluSniff(at, tick, palu.restLeft)
  else if (palu.act === 'wander') paluSit(painter(ctx, Math.round(palu.x) + 4, Math.round(palu.y) - 2), tick)
  else paluLie(at, tick, true, palu.restLeft)
}

function drawSeat(seat) {
  const p = painter(ctx, seat.x, seat.y)
  person(p, seat.staff, tick, walkers.has(seat.key))
}

function drawText(text, cssX, cssY, maxW, color, { weight = 600, align = 'left', size = 11 } = {}) {
  cssTransform()
  ctx.font = `${weight} ${size}px ui-monospace, 'SF Mono', Menlo, monospace`
  ctx.textBaseline = 'middle'
  ctx.textAlign = align
  ctx.fillStyle = color
  let label = String(text ?? '')
  if (ctx.measureText(label).width > maxW) {
    while (label.length > 1 && ctx.measureText(label + '...').width > maxW) label = label.slice(0, -1)
    label += '...'
  }
  ctx.fillText(label, cssX, cssY)
  ctx.textAlign = 'left'
  artTransform()
}

function drawBubble(seat, text) {
  const s = layout.scale
  cssTransform()
  ctx.font = `500 12px ui-monospace, 'SF Mono', Menlo, monospace`
  const maxW = Math.min(220, layout.artW * s - 12)
  let label = text
  while (label.length > 1 && ctx.measureText(label).width > maxW - 14) label = label.slice(0, -2) + '.'
  const w = Math.ceil(ctx.measureText(label).width) + 14
  const h = 20
  const cx = (seat.x + SEAT_W / 2) * s
  let x = Math.round(cx - w / 2)
  x = Math.max(6, Math.min(x, layout.artW * s - w - 6))
  const y = Math.max(4, Math.round(seat.y * s - h - 2))
  ctx.fillStyle = '#e9fbef'
  ctx.strokeStyle = '#3a8f5c'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, 7)
  ctx.fill()
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(cx - 4, y + h)
  ctx.lineTo(cx, y + h + 6)
  ctx.lineTo(cx + 4, y + h)
  ctx.fill()
  ctx.fillStyle = C.ink
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + 7, y + h / 2 + 1)
  artTransform()
}

function draw() {
  artTransform()
  const p = painter(ctx)
  drawBuilding(p)
  for (const room of layout.rooms) drawRoom(p, room)
  const behind = drawCommon()

  // desks: people first, then the desk over their laps, then monitors and hands
  for (const seat of layout.seats) drawSeat(seat)
  for (const seat of layout.seats) desk(painter(ctx, seat.x - 2, seat.y), DESK_W)
  for (const seat of layout.seats) workstation(painter(ctx, seat.x, seat.y), seat.staff, tick, walkers.has(seat.key))
  // stools at the end of each desk, then whoever is sitting on them
  for (const seat of layout.seats) {
    for (const at of seat.stools) stool(painter(ctx, at.x, at.y))
    if (seat.overflow) {
      const last = seat.stools[seat.stools.length - 1]
      glyph(p, '+', last.x + 2, last.y - 13, C.white)
    }
  }
  for (const v of visitors.values()) {
    if (v.mode === 'seated') specialist(painter(ctx, Math.round(v.x) + 1, Math.round(v.y) + 2), v.spec, tick)
  }

  // people up and about, nearest the bottom drawn last
  const walking = layout.seats.filter((seat) => walkers.has(seat.key) && !behind.has(seat.key))
  walking.sort((a, b) => walkers.get(a.key).y - walkers.get(b.key).y)
  for (const seat of walking) {
    const w = walkers.get(seat.key)
    const at = painter(ctx, Math.round(w.x), Math.round(w.y))
    const kind = w.mode === 'away' ? w.activity?.kind : null
    if (kind === 'lounge') lounger(at, seat.staff, tick, w.activity.pose)
    else if (kind === 'booth') walker(at, seat.staff, tick, false, w.left, null, 'phone')
    else if (kind === 'foosball') walker(at, seat.staff, tick, false, w.left, null, w.spot.back ? 'playBack' : 'play')
    else walker(at, seat.staff, tick, w.path.length > 0, w.left)
  }
  if (layout.common) for (const b of layout.common.booths) boothGlass(painter(ctx, b.bx, b.by))
  if (!behind.has('palu')) drawPalu()
  const moving = [...visitors]
    .filter(([key, v]) => v.mode !== 'seated' && !(v.wait > 0) && !behind.has(key))
    .map(([, v]) => v)
    .sort((a, b) => a.y - b.y)
  for (const v of moving) {
    walker(painter(ctx, Math.round(v.x), Math.round(v.y)), v.spec, tick, true, v.left, roleColor(v.spec.role))
  }

  const s = layout.scale
  for (const room of layout.rooms) {
    drawText(room.name, (room.x + 5) * s, (room.y + 6.5) * s, (Math.min(room.w - 40, 56) - 4) * s, C.white, { weight: 700 })
  }
  for (const seat of layout.seats) {
    const color = seat.key === selected ? '#2a1f6b' : '#2a2633'
    drawText(seatLabel(seat), (seat.x + SEAT_W / 2) * s, (seat.y + SEAT_H + 2.5) * s, (DESK_W + 2) * s, color, { align: 'center', size: 10 })
  }

  const pickSeat = layout.seats.find((u) => u.key === selected)
  if (pickSeat) {
    artTransform()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 0.5
    ctx.strokeRect(pickSeat.x + 0.25, pickSeat.y + 0.25, SEAT_W - 0.5, SEAT_H + LABEL_H - 0.5)
  }

  const now = Date.now()
  for (const seat of layout.seats) {
    const b = bubbles.get(seat.key)
    if (seat.key === selected) drawBubble(seat, seat.staff.said ?? STATE_LABEL[seat.staff.state])
    else if (b && b.until > now) drawBubble(seat, b.text)
  }
}

// ---- side text ---------------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function renderStats() {
  let busy = 0
  let specialists = 0
  let needYou = 0
  for (const u of layout.seats) {
    if (u.staff.state === 'working' || u.staff.state === 'monitoring') busy++
    if (u.staff.state === 'waiting' || u.staff.state === 'blocked') needYou++
    specialists += activeSpecialists(u.staff).length
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
  const parts = [plural(layout.rooms.length, 'team'), `${layout.seats.length} staff`, `${busy} busy`]
  if (specialists) parts.push(plural(specialists, 'specialist'))
  if (needYou) parts.push(`${needYou} need you`)
  document.getElementById('stats').textContent = parts.join(' · ')
}

async function requestSnapshot() {
  if (typeof orca !== 'undefined' && orca?.plugin?.request) {
    return await orca.plugin.request('office.snapshot', undefined, { timeoutMs: 15000 })
  }
  const res = await fetch('/api/snapshot')
  return await res.json()
}

function requestSwitch(paneKey) {
  if (!paneKey) return
  if (typeof orca !== 'undefined' && orca?.plugin?.request) {
    orca.plugin.request('office.switch', { paneKey }).catch(() => {})
  } else {
    fetch('/api/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paneKey })
    }).catch(() => {})
  }
}

function renderDetail() {
  const box = document.getElementById('detail')
  const seat = layout.seats.find((u) => u.key === selected)
  if (!seat) {
    box.hidden = true
    return
  }
  const { desk: d, staff, room } = seat
  const title = staff.name ? staff.name : d.name
  const header = el('div', 'title', title)
  header.style.fontWeight = '700'
  header.style.fontSize = '13px'
  header.style.color = 'var(--orca-foreground, inherit)'
  header.style.marginBottom = '4px'

  const lines = [header]
  lines.push(el('div', 'row', `📁 ${room.name} · 🌿 ${d.branch ?? d.name}`))
  lines.push(el('div', 'row', `🤖 ${staff.agent ?? 'agent'} · ${STATE_LABEL[staff.state]} for ${since(staff.since)}`))
  if (staff.tool && staff.state === 'working') lines.push(el('div', 'row', `⚡ using ${staff.tool}`))
  if (staff.task && staff.task !== staff.name) lines.push(el('div', 'row', `📋 ${staff.task}`))
  if (staff.said) lines.push(el('div', 'row', `💬 "${staff.said}"`))
  for (const sp of activeSpecialists(staff)) {
    lines.push(el('div', 'row', `👥 ${sp.role ?? 'specialist'}: ${sp.task ?? ''} (${STATE_LABEL[sp.state]})`))
  }
  if (staff.id) {
    const btn = el('button', 'switch-btn', '↗ Abrir pestaña en Orca')
    btn.style.cssText = 'margin-top:8px;padding:4px 10px;background:var(--orca-button-background,#3a3650);color:var(--orca-button-foreground,#fff);border:1px solid var(--orca-muted,#555);border-radius:4px;cursor:pointer;font-family:inherit;font-size:11px;font-weight:600;'
    btn.onclick = (e) => {
      e.stopPropagation()
      requestSwitch(staff.id)
    }
    lines.push(btn)
  }
  box.replaceChildren(...lines)
  box.hidden = false
}

function showMessage(text) {
  const msg = document.getElementById('message')
  msg.textContent = text ?? ''
  msg.hidden = !text
}

/** Pops a bubble on a seat whose agent just finished or needs you. */
function noteChanges() {
  const now = Date.now()
  for (const seat of layout.seats) {
    const prev = lastState.get(seat.key)
    const state = seat.staff.state
    if (primed && prev && prev !== state) {
      let text = null
      if (state === 'done') text = seat.staff.said ?? 'Done!'
      else if (state === 'waiting') text = 'Need you!'
      else if (state === 'blocked') text = 'Stuck!'
      if (text) bubbles.set(seat.key, { text, until: now + BUBBLE_MS })
    }
    lastState.set(seat.key, state)
  }
  primed = true
}

function apply(next) {
  snapshot = next
  resize()
  noteChanges()
  renderStats()
  renderDetail()
  if (layout.seats.length === 0) {
    showMessage(next.error ? `Could not read the agents: ${next.error}` : 'The office is empty. Start an agent and it gets a desk.')
  } else showMessage(null)
}

// ---- input and loops -------------------------------------------------------------------------

function artPoint(event) {
  const rect = canvas.getBoundingClientRect()
  return [(event.clientX - rect.left) / layout.scale, (event.clientY - rect.top) / layout.scale]
}

/** Palú when the point is on him (with a pixel to spare, he is small). */
function onPalu(ax, ay) {
  const dog = paluBox()
  return Boolean(dog) && overlaps(dog.box, [ax - 1, ay - 1, 2, 2])
}

// Floating hover tooltip for seats and Palú
const tooltip = document.createElement('div')
tooltip.id = 'seat-tooltip'
tooltip.style.cssText = 'position:fixed;display:none;pointer-events:none;z-index:9999;padding:6px 10px;background:var(--orca-popover,#1f1c2b);color:var(--orca-popover-foreground,#eee);border:1px solid var(--orca-muted,#3d3755);border-radius:6px;font-size:11px;line-height:1.45;box-shadow:0 4px 14px rgba(0,0,0,0.45);max-width:320px;backdrop-filter:blur(8px);'
document.body.appendChild(tooltip)

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

canvas.addEventListener('mousemove', (event) => {
  const [ax, ay] = artPoint(event)
  const hit = layout.seats.find((u) => ax >= u.x && ax < u.x + SEAT_W && ay >= u.y && ay < u.y + SEAT_H + LABEL_H)
  const onDog = onPalu(ax, ay)
  canvas.style.cursor = hit || onDog ? 'pointer' : ''

  if (hit) {
    const { desk: d, staff, room } = hit
    const title = staff.name || d.name
    const stateInfo = `🤖 <strong>${escapeHtml(staff.agent || 'agent')}</strong> · <span style="color:var(--orca-primary,#82aaff)">${escapeHtml(STATE_LABEL[staff.state])}</span> (${since(staff.since)})`
    const locInfo = `📁 ${escapeHtml(room.name)} · 🌿 ${escapeHtml(d.branch || d.name)}`
    const toolInfo = staff.tool && staff.state === 'working' ? `<br>⚡ using <code>${escapeHtml(staff.tool)}</code>` : ''
    const saidInfo = staff.said ? `<br>💬 <em>"${escapeHtml(staff.said)}"</em>` : ''
    const specInfo = staff.specialists?.length ? `<br>👥 ${escapeHtml(staff.specialists.map((s) => s.role).filter(Boolean).join(', '))}` : ''

    tooltip.innerHTML = `<div style="font-weight:700;margin-bottom:3px;color:var(--orca-foreground,#fff);">${escapeHtml(title)}</div><div style="color:var(--orca-muted-foreground,#9a97a8);font-size:10.5px;">${locInfo}<br>${stateInfo}${toolInfo}${saidInfo}${specInfo}</div>`
    tooltip.style.display = 'block'
    const x = Math.min(window.innerWidth - 330, event.clientX + 14)
    const y = Math.min(window.innerHeight - 120, event.clientY + 14)
    tooltip.style.left = `${Math.max(10, x)}px`
    tooltip.style.top = `${Math.max(10, y)}px`
  } else if (onDog) {
    tooltip.innerHTML = `<strong>Palú 🐾</strong><br><span style="color:var(--orca-muted-foreground,#9a97a8)">The office dog. Click to pet him!</span>`
    tooltip.style.display = 'block'
    tooltip.style.left = `${event.clientX + 14}px`
    tooltip.style.top = `${event.clientY + 14}px`
  } else {
    tooltip.style.display = 'none'
  }
})

canvas.addEventListener('mouseleave', () => {
  tooltip.style.display = 'none'
})

canvas.addEventListener('click', (event) => {
  const [ax, ay] = artPoint(event)
  // a pat wakes Palú: if he is resting, he gets up and goes on to whatever he does next
  if (onPalu(ax, ay)) {
    if (!palu.path.length) paluNext()
    return
  }
  const hit = layout.seats.find((u) => ax >= u.x && ax < u.x + SEAT_W && ay >= u.y && ay < u.y + SEAT_H + LABEL_H)
  selected = hit && hit.key !== selected ? hit.key : null
  renderDetail()
  draw()
  if (hit && hit.staff?.id) {
    requestSwitch(hit.staff.id)
  }
})

async function poll() {
  if (document.visibilityState !== 'hidden') {
    try {
      apply(await requestSnapshot())
    } catch (error) {
      if (layout.seats.length === 0) showMessage(`The worker did not answer: ${error?.message ?? error}`)
    }
  }
  setTimeout(poll, POLL_MS)
}

setInterval(() => {
  if (document.visibilityState === 'hidden') return
  tick++
  stepWalkers()
  stepVisitors()
  stepPalu()
  if (snapshot) scenePrimed = true
  draw()
}, FRAME_MS)

// The canvas sets the office's height, so react to width only, or every resize re-fires.
let lastWidth = 0
new ResizeObserver(([entry]) => {
  const width = Math.round(entry.contentRect.width)
  if (width === lastWidth) return
  lastWidth = width
  // Lay out on the next frame, outside the observer callback, so the resize cannot re-fire it.
  requestAnimationFrame(resize)
}).observe(document.getElementById('office'))

showMessage('Opening the office...')
poll()
