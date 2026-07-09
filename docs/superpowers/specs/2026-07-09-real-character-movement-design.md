# Real Character Movement Design

## Goal

Replace the `act-move` teleport behavior with visible Factorio character walking. This phase intentionally handles movement only; building, mining, insertion, extraction, rotation, and recipe selection can keep their current behavior until the later building/action phase.

## Current behavior

- `src/server.ts` has `agentMoveCommand`, which finds a non-colliding position and calls `player.teleport(safe_pos)`.
- The `/api/agent/act/move` handler probes player position, waits for simulated walking time using `walkDelayMs(distance)`, then runs the teleport command.
- Several other actions have separate `ensure_reach` helpers that teleport near an entity before acting. Those are out of scope for this phase.
- `src/agent-cli.ts` help text tells agents movement is simulated, which will become inaccurate for `act-move`.

## Decision

Implement phase 1 as straight-line real walking with blocked feedback:

- Use Factorio `player.walking_state` through RCON to make the character walk.
- Poll player position from Node while walking.
- Stop walking when the player is within a small tolerance of the requested target.
- If progress stalls for a short window, stop walking and return `ok:false`, `blocked:true`, current position, target, elapsed time, and distance remaining.
- Do not add pathfinding or automatic sidestepping in this phase.

This gives Codex a reliable primitive for visible movement. When blocked, Codex can observe the world, choose an intermediate waypoint, and try again.

## API behavior

`POST /api/agent/act/move` keeps the existing input shape:

```json
{
  "targets": [{ "x": 10, "y": 20 }]
}
```

Each result should include:

```json
{
  "x": 10,
  "y": 20,
  "ok": true,
  "reached": true,
  "blocked": false,
  "position": { "x": 10.46, "y": 20.48 },
  "target": { "x": 10.5, "y": 20.5 },
  "distance_remaining": 0.06,
  "elapsed_ms": 1320,
  "steps": 8
}
```

Blocked movement should return HTTP 200 with a failed per-target result, not fail the whole request:

```json
{
  "x": 10,
  "y": 20,
  "ok": false,
  "reached": false,
  "blocked": true,
  "position": { "x": 7.12, "y": 20.49 },
  "target": { "x": 10.5, "y": 20.5 },
  "distance_remaining": 3.38,
  "elapsed_ms": 1800,
  "steps": 9,
  "error": "blocked"
}
```

## Movement model

- Convert requested tile coordinates to tile-center targets by adding `0.5` to `x` and `y`, matching the current endpoint semantics.
- Pick a walking direction from the vector between current position and target.
- Prefer eight-way movement using Factorio's direction constants:
  - north: `0`
  - northeast: `2`
  - east: `4`
  - southeast: `6`
  - south: `8`
  - southwest: `10`
  - west: `12`
  - northwest: `14`
- Poll at a short interval, around 150 ms.
- Stop when distance to target is at or below about `0.25` tiles.
- Treat movement as blocked when distance has not improved by at least about `0.05` tiles over about `900` ms.
- Stop walking before returning in every success, failure, and exception path.

## Out of scope

- Automatic obstacle avoidance.
- Pathfinding.
- Changing build/mine/insert/extract/rotate/set-recipe behavior.
- Replacing direct entity creation with player-held item placement.

## Follow-up phase

After `act-move` is physically walking, building can be changed to:

- require explicit movement or call a shared walking helper to get into reach,
- use reach checks instead of teleporting,
- place entities through normal player-like behavior where possible,
- return diagnostics when placement fails because of range, inventory, collision, or missing item.
