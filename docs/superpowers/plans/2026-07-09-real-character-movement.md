# Real Character Movement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `act-move` physically walk the Factorio character to target tile centers and fail with useful blocked feedback instead of teleporting.

**Architecture:** Keep movement orchestration in `src/server.ts` because the existing API and RCON bridge live there. Replace `agentMoveCommand` teleporting with small RCON commands that set/stop `player.walking_state`, while the Node HTTP handler polls position and decides success, blocked, or timeout.

**Tech Stack:** TypeScript, Node HTTP server, Factorio RCON Lua snippets, existing CLI in `src/agent-cli.ts`, `npm run build` for verification.

---

## File Structure

- Modify `src/server.ts`
  - Add movement constants near the existing action constants.
  - Replace teleport-oriented `agentMoveCommand` with `agentSetWalkingCommand` and `agentStopWalkingCommand`.
  - Add TypeScript helpers for target normalization, direction selection, position probing, and the real walking loop.
  - Update the `/api/agent/act/move` handler to call the walking loop for each target.
- Modify `src/agent-cli.ts`
  - Update `act-move` help text to say this command physically walks and can report blocked movement.
  - Leave command input/output plumbing unchanged.
- Verify with `npm run build`.
- Manually verify against a running Factorio server and connected client when available.

---

### Task 1: Add Pure Movement Types And Direction Helpers

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add movement constants near `CHARACTER_WALK_SPEED_TPS`**

Add this immediately after the existing `CHARACTER_WALK_SPEED_TPS` constant:

```ts
const AGENT_MOVE_POLL_MS = 150;
const AGENT_MOVE_REACHED_DISTANCE = 0.25;
const AGENT_MOVE_BLOCKED_WINDOW_MS = 900;
const AGENT_MOVE_MIN_PROGRESS = 0.05;
const AGENT_MOVE_TIMEOUT_PADDING_MS = 1500;
const AGENT_MOVE_MIN_TIMEOUT_MS = 3000;
```

- [ ] **Step 2: Add movement helper types near the existing utility helpers**

Add this after `walkDelayMs`:

```ts
type Point = { x: number; y: number };

type WalkToTargetResult = {
  x: number;
  y: number;
  ok: boolean;
  reached: boolean;
  blocked: boolean;
  position: Point | null;
  target: Point;
  distance_remaining: number | null;
  elapsed_ms: number;
  steps: number;
  error?: string;
};

function tileCenter(target: Point): Point {
  return {
    x: Number(target.x) + 0.5,
    y: Number(target.y) + 0.5,
  };
}

function distanceBetween(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
```

- [ ] **Step 3: Add direction selection helper**

Add this after `distanceBetween`:

```ts
function walkingDirection(from: Point, to: Point): number | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) <= AGENT_MOVE_REACHED_DISTANCE) return null;

  const horizontal = Math.abs(dx) >= 0.15 ? Math.sign(dx) : 0;
  const vertical = Math.abs(dy) >= 0.15 ? Math.sign(dy) : 0;

  if (vertical < 0 && horizontal === 0) return 0;
  if (vertical < 0 && horizontal > 0) return 2;
  if (vertical === 0 && horizontal > 0) return 4;
  if (vertical > 0 && horizontal > 0) return 6;
  if (vertical > 0 && horizontal === 0) return 8;
  if (vertical > 0 && horizontal < 0) return 10;
  if (vertical === 0 && horizontal < 0) return 12;
  if (vertical < 0 && horizontal < 0) return 14;

  return null;
}
```

- [ ] **Step 4: Run build to catch type mistakes**

Run:

```powershell
npm run build
```

Expected: TypeScript compile succeeds.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/server.ts
git commit -m "feat: add movement direction helpers"
```

---

### Task 2: Replace Teleport Move Command With Walking RCON Commands

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Replace `agentMoveCommand`**

Replace the existing `function agentMoveCommand(target: { x: number; y: number }): string { ... }` with these two functions:

```ts
function agentSetWalkingCommand(direction: number): string {
  const parts = [
    "/sc",
    "local player=game.players[1]",
    'if not player then rcon.print(\'{"ok":false,"error":"No player"}\') return end',
    "if not player.character then rcon.print('{\"ok\":false,\"error\":\"no_character\"}') return end",
    `player.walking_state={walking=true,direction=${direction}}`,
    "rcon.print('{\"ok\":true}')",
  ];
  return parts.join(" ");
}

function agentStopWalkingCommand(): string {
  const parts = [
    "/sc",
    "local player=game.players[1]",
    'if not player then rcon.print(\'{"ok":false,"error":"No player"}\') return end',
    "if player.character then player.walking_state={walking=false,direction=defines.direction.north} end",
    "rcon.print('{\"ok\":true}')",
  ];
  return parts.join(" ");
}
```

- [ ] **Step 2: Confirm no old move command callers remain except the handler that will be updated next**

Run:

```powershell
Select-String -Path src\server.ts -Pattern "agentMoveCommand"
```

Expected: no matches.

- [ ] **Step 3: Run build**

Run:

```powershell
npm run build
```

Expected: build fails because the `/api/agent/act/move` handler still references `agentMoveCommand`.

- [ ] **Step 4: Commit after Task 3 instead of now**

Do not commit this broken intermediate state. Continue directly to Task 3, then commit both tasks together.

---

### Task 3: Add The Server-Side Walking Loop

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add a position probe helper**

Add this near the other RCON helper functions:

```ts
async function probeAgentPlayerPosition(): Promise<Point> {
  const probeResponse = await rconCommand(agentPlayerPositionCommand());
  const probe = parseRconJson<any>(
    probeResponse,
    "RCON probe returned invalid JSON",
  );
  if (probe?.error) {
    throw new Error(probe.error);
  }
  const playerPos = probe?.player;
  if (
    !playerPos ||
    !Number.isFinite(playerPos.x) ||
    !Number.isFinite(playerPos.y)
  ) {
    throw new Error("probe_failed");
  }
  return { x: Number(playerPos.x), y: Number(playerPos.y) };
}
```

- [ ] **Step 2: Add a stop helper**

Add this after `probeAgentPlayerPosition`:

```ts
async function stopAgentWalking(): Promise<void> {
  try {
    const response = await rconCommand(agentStopWalkingCommand());
    const data = parseRconJson<any>(
      response,
      "RCON stop walking returned invalid JSON",
    );
    if (data?.ok === false) {
      throw new Error(data?.error || "stop_walking_failed");
    }
  } catch {
    // Movement callers should return the original movement result when stopping fails.
  }
}
```

- [ ] **Step 3: Add the walking loop**

Add this after `stopAgentWalking`:

```ts
async function walkAgentToTarget(rawTarget: Point): Promise<WalkToTargetResult> {
  const requested = { x: Number(rawTarget.x), y: Number(rawTarget.y) };
  const target = tileCenter(requested);
  const started = Date.now();
  let steps = 0;
  let position: Point | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestProgressAt = started;
  const expectedDistance = Number.isFinite(requested.x) && Number.isFinite(requested.y)
    ? distanceBetween(await probeAgentPlayerPosition(), target)
    : 0;
  const timeoutMs = Math.max(
    AGENT_MOVE_MIN_TIMEOUT_MS,
    walkDelayMs(expectedDistance) + AGENT_MOVE_TIMEOUT_PADDING_MS,
  );

  try {
    while (Date.now() - started <= timeoutMs) {
      position = await probeAgentPlayerPosition();
      const distance = distanceBetween(position, target);
      if (distance <= AGENT_MOVE_REACHED_DISTANCE) {
        await stopAgentWalking();
        return {
          x: requested.x,
          y: requested.y,
          ok: true,
          reached: true,
          blocked: false,
          position,
          target,
          distance_remaining: distance,
          elapsed_ms: Date.now() - started,
          steps,
        };
      }

      if (distance < bestDistance - AGENT_MOVE_MIN_PROGRESS) {
        bestDistance = distance;
        bestProgressAt = Date.now();
      } else if (Date.now() - bestProgressAt >= AGENT_MOVE_BLOCKED_WINDOW_MS) {
        await stopAgentWalking();
        return {
          x: requested.x,
          y: requested.y,
          ok: false,
          reached: false,
          blocked: true,
          position,
          target,
          distance_remaining: distance,
          elapsed_ms: Date.now() - started,
          steps,
          error: "blocked",
        };
      }

      const direction = walkingDirection(position, target);
      if (direction === null) {
        await stopAgentWalking();
        return {
          x: requested.x,
          y: requested.y,
          ok: true,
          reached: true,
          blocked: false,
          position,
          target,
          distance_remaining: distance,
          elapsed_ms: Date.now() - started,
          steps,
        };
      }

      const response = await rconCommand(agentSetWalkingCommand(direction));
      const data = parseRconJson<any>(
        response,
        "RCON set walking returned invalid JSON",
      );
      if (!data || data.ok === false) {
        await stopAgentWalking();
        return {
          x: requested.x,
          y: requested.y,
          ok: false,
          reached: false,
          blocked: false,
          position,
          target,
          distance_remaining: distance,
          elapsed_ms: Date.now() - started,
          steps,
          error: data?.error || "set_walking_failed",
        };
      }

      steps += 1;
      await new Promise((resolve) => setTimeout(resolve, AGENT_MOVE_POLL_MS));
    }

    position = await probeAgentPlayerPosition();
    const distance = distanceBetween(position, target);
    await stopAgentWalking();
    return {
      x: requested.x,
      y: requested.y,
      ok: false,
      reached: false,
      blocked: false,
      position,
      target,
      distance_remaining: distance,
      elapsed_ms: Date.now() - started,
      steps,
      error: "timeout",
    };
  } catch (err: any) {
    await stopAgentWalking();
    return {
      x: requested.x,
      y: requested.y,
      ok: false,
      reached: false,
      blocked: false,
      position,
      target,
      distance_remaining: position ? distanceBetween(position, target) : null,
      elapsed_ms: Date.now() - started,
      steps,
      error: err?.message || "move_failed",
    };
  }
}
```

- [ ] **Step 4: Remove double probing if desired after tests pass**

The code above probes once to estimate timeout and then again in the loop. Keep it for the first implementation because it is simple and correct. Do not optimize this until movement is verified in-game.

- [ ] **Step 5: Build still fails until the handler is updated**

Run:

```powershell
npm run build
```

Expected: failure still points at the old `agentMoveCommand` handler reference.

---

### Task 4: Update `/api/agent/act/move` Handler

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Replace the per-target body in the move handler**

Inside the `/api/agent/act/move` handler, replace the current loop body that probes, sleeps, and calls `agentMoveCommand` with:

```ts
      for (const target of trimmed) {
        results.push(
          await walkAgentToTarget({
            x: Number(target.x),
            y: Number(target.y),
          }),
        );
      }
```

The handler should still return:

```ts
      return json(res, 200, { data: results, truncated: targets.length > max });
```

- [ ] **Step 2: Run build**

Run:

```powershell
npm run build
```

Expected: TypeScript compile succeeds.

- [ ] **Step 3: Commit Tasks 2-4**

Run:

```powershell
git add src/server.ts
git commit -m "feat: walk character for move actions"
```

---

### Task 5: Update CLI Help For Real Movement

**Files:**
- Modify: `src/agent-cli.ts`

- [ ] **Step 1: Update general note**

Change the general note:

```ts
  - Actions that require the player to be near a target (build/mine/rotate/insert/extract/set-recipe)
    are NOT instant. The server simulates walking time based on distance before the action completes.
```

to:

```ts
  - act-move physically walks the character and can fail with blocked=true.
  - Other actions that require the player to be near a target currently still simulate walking time
    before completing.
```

- [ ] **Step 2: Update `act-move` help**

Change:

```ts
"Note: This action includes simulated walking time based on distance.\n"
```

to:

```ts
"Note: This action physically walks the character and may return blocked=true if movement stalls.\n"
```

Only change the `act-move` help block. Leave build/mine/insert/extract help unchanged for this phase.

- [ ] **Step 3: Run build**

Run:

```powershell
npm run build
```

Expected: TypeScript compile succeeds.

- [ ] **Step 4: Commit**

Run:

```powershell
git add src/agent-cli.ts
git commit -m "docs: describe real move behavior in CLI help"
```

---

### Task 6: Manual Factorio Verification

**Files:**
- No source edits required.

- [ ] **Step 1: Start the compiled server**

Run:

```powershell
npm run start
```

Expected: server starts on the configured port, typically `http://127.0.0.1:3100`.

- [ ] **Step 2: Confirm server and RCON are connected**

In another terminal, run:

```powershell
npm run agent -- server-status
```

Expected: response shows the Factorio process running and RCON connected.

- [ ] **Step 3: Observe the player**

Run:

```powershell
npm run agent -- observe-player
```

Expected: response includes `player.position.x` and `player.position.y`.

- [ ] **Step 4: Move to a nearby open tile while watching the connected Factorio client**

Choose a target about 3 to 8 tiles away from the observed player position. Then run:

```powershell
npm run agent -- act-move -- --target "X,Y"
```

Expected:

```json
{
  "ok": true,
  "cmd": "act-move",
  "data": [
    {
      "ok": true,
      "reached": true,
      "blocked": false
    }
  ]
}
```

The graphical Factorio client should visibly show the character walking, not teleporting.

- [ ] **Step 5: Move into an obstacle**

Pick a target behind a tree, rock, machine, or water edge. Run:

```powershell
npm run agent -- act-move -- --target "X,Y"
```

Expected: the result includes `ok:false`, `reached:false`, `blocked:true`, `position`, `target`, and `distance_remaining`. The player should stop walking before the command returns.

- [ ] **Step 6: Commit verification notes if source/docs changed**

If verification reveals tuning changes and they are made, commit them:

```powershell
git add src/server.ts src/agent-cli.ts
git commit -m "fix: tune real movement detection"
```

---

## Self-Review

- Spec coverage: The plan implements real movement for `act-move`, returns blocked feedback, leaves building and other actions unchanged, and updates CLI wording.
- Placeholder scan: No `TBD`, `TODO`, "similar to", or unspecified test steps remain.
- Type consistency: The plan consistently uses `Point`, `WalkToTargetResult`, `walkAgentToTarget`, `agentSetWalkingCommand`, and `agentStopWalkingCommand`.
