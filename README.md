# Orca Tycoon

Your coding agents, as tiny pixel staff in an office you can watch.

![The Orca Tycoon office: five teams at their desks, specialists on stools beside their agents, and a commons band in the middle with the lounge, coffee corner, foosball table, calling booths and Palú asleep in his bed](docs/office.png)

Orca Tycoon is a plugin for [Orca](https://github.com/stablyai/orca), the desktop app for running
many coding agents in parallel git worktrees. It draws every agent on your machine as a little
worker in an office, in the style of tycoon and office-sim games. You get a glance at who is busy,
who needs you and who is done, without having to click through every workspace.

## Install

Requires Orca 1.4.246 or newer.

In Orca, open **Settings → Plugins**, and install **Orca Tycoon** (`palulabs.office-tycoon`) from the plugin directory.

To run it from a clone or development folder instead:

```sh
git clone https://github.com/palulabs/orca-tycoon.git ~/projects/orca-tycoon
# Or from fork: git clone https://github.com/oscabreraCP/orca-tycoon.git ~/projects/orca-tycoon
cd ~/projects/orca-tycoon
orca plugin dev load .        # prints an approval; re-run with the --approve flag it shows
orca plugin open local.office-tycoon --panel office
```

### Features & Improvements:
- **Smart Desk Labels:** Shows ticket keys (`IT-XXXXX`, `#19977`) or clean tab conversation names under each desk instead of repeating generic branch names.
- **Hover Card Tooltip:** Hovering over any desk displays a floating card with full tab name, active agent, state, duration, tool (`Bash`, etc.), repo, branch, subagents, and last message preview.
- **Click to Switch Tab:** Clicking any desk directly focuses/switches to that terminal tab in Orca (`orca terminal switch`). Also adds an `[ ↗ Abrir pestaña en Orca ]` button in the details panel.
- **Standalone Local Server (Optional):** Run `node server.mjs` to view Tycoon at `http://localhost:3456` or in an Orca browser tab (`orca tab create --url http://127.0.0.1:3456`).

The worker looks for the Orca CLI at `/Applications/Orca.app/Contents/Resources/bin/orca`, then
`~/Applications/...`, then `orca` on your `PATH`.

## Who works here

- **Projects are teams.** Each repository gets its own open area on the office floor. A big
  team spreads across the full width; small ones share the floor in two columns.
- **Agents get desks.** Every agent has a seat with a monitor facing you. A worktree's child
  worktrees sit right next to it, so a stack of branches reads as one row of desks.
- **Subagents are specialists.** Every desk has a stool at its end, the second seat. When an
  agent calls in a subagent, a specialist walks in through the front door in the side wall, sits on that stool
  leaning in toward the screen, and leaves the same way when the job is done. A desk grows up to
  three stools and shows `+N` beyond that. The badge on a specialist's shirt is coloured by role,
  the same across the whole office.
- **Idle agents take a break.** A band across the middle of the floor holds the commons: a lounge
  with a sofa, the coffee corner and kitchen, a foosball table and calling booths. Agents that are
  done, idle, or waiting on background tasks walk over and pick something to do. Every minute
  each one draws a new activity on a rhythm of its own, so they never all move at once: a nap on
  the sofa (done and idle agents only), a coffee or a book on the sofa, a mug at the coffee corner,
  a game of foosball (always two players, one on each long side), or a call in a booth. When a
  place is full they take their next choice, and when everything is full they stay at their desk.
  When an agent gets new work, it walks back and sits down.
- **Palú is the office dog.** A white, fluffy, long and low bichon with a little stub of a tail
  and a red collar. He wanders the floor, sniffs the plants, the bookshelves and the corners of
  the furniture, visits his food and water bowls, naps in his bed in the commons, and now and
  then lies down in front of someone's desk for a nap, more often beside someone who is dozing
  too. Click him while he rests and he gets up and goes on to whatever he does next. He is only
  there for company and never changes what anyone does.
- **Agents speak up.** When an agent finishes, a speech bubble shows the first line of its last
  reply. When one starts waiting for you it says "Need you!", and when it gets stuck it says
  "Stuck!".

A status line along the top counts teams, staff, busy agents and how many need you.

## Reading the monitors

![One desk per state on a narrow panel: a red flashing exclamation mark, an amber question mark and typing at their desks, while the done agent naps on the sofa and the monitoring one takes a call in a booth](docs/states.png)

| Agent state | What you see |
| --- | --- |
| working | typing, code scrolling on screen |
| watching background tasks | on a break in the commons, never napping |
| waiting for you | amber `?` on screen |
| blocked | red flashing screen with `!` |
| done | on a break in the commons, often napping; dozing at the desk with a `z` when the commons are full |

Click a seat to pin its speech bubble and see the worktree, state, task, current tool and specialists.

![An agent finishes with a speech bubble, walks down to the commons and takes a call in a booth, then walks back to its desk when new work arrives](docs/break.gif)

![Two specialists come in through the front door one after the other and take the stools at a desk, while another finishes and walks out](docs/specialists.gif)

## How it works

Orca's plugin API (`agents.list`) only lists the agents of the focused workspace, and it has no
subagents. To see the whole office, the worker (`src/worker.ts`) runs `orca worktree ps --json`
instead. Orca's own sidebar and phone app draw from the same rows. The worker trims them to a small
office model (`src/protocol.ts`): projects, seats, and each seat's specialists.

The panel (`src/panel.html`, `src/panel.js`, `src/sprites.js`) polls the worker every 3 seconds,
the same rate Orca's phone app uses, and draws one canvas at 8 frames a second. Every sprite is
drawn in code, so the plugin loads no assets and makes no network requests.

### Permissions

Because the worker runs the Orca CLI, the plugin needs the `trusted-worker` execution profile. It
asks for no other capabilities.

## Develop

```sh
orca plugin validate .
orca plugin test .            # src/worker.test.ts: ps rows to the office model
orca plugin dev reload .      # after editing; the panel redraws
orca plugin shot local.office-tycoon --panel office --out shot.png
```

At the top of `src/panel.js`, `AWAY_STATES` and `LOUNGE_STATES` decide which states send an agent
on a break, and `ACTIVITIES` lists what they can do there, with a weight for how often each comes
up. Add `waiting` to `AWAY_STATES` if you'd like agents that wait for you to take a break too.

The screenshots in `docs/` show a made-up office, rendered from the real panel code.

## License

[MIT](LICENSE)

Orca Tycoon is a community plugin and is not affiliated with Orca or Stably.

Palú, the office dog, is named after the bichon who gave Palu Labs its name. In loving memory,
2003 to 2018.
