# Real Character Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make build, mine, rotate, set-recipe, insert, and extract physically approach their targets and obey Factorio 2.0.73 player rules without teleporting, simulated travel delays, direct entity creation, or instant mining.

**Architecture:** Keep HTTP and process management in `src/server.ts`, move action coordination into a dependency-injected `AgentActionController`, and isolate Factorio 2.0.73 Lua/RCON operations in `src/factorio-action-adapter.ts`. One FIFO lock serializes public move and all target actions; the controller owns candidate fallback and timed polling, while each adapter command performs one bounded Factorio operation.

**Tech Stack:** TypeScript 5.7, Node.js 22, built-in `node:test`, existing `tsx` 4.19 test loader, Factorio 2.0.73 runtime Lua API, existing RCON bridge.

## Global Constraints

- Preserve all existing HTTP request shapes and CLI flags.
- Preserve response envelopes: build/mine/rotate/set-recipe use `{ ok:true, data:{ results }, truncated }`; insert/extract use `{ ok:true, data }`.
- Gameplay failures return HTTP 200 with `ok:false` in the affected result; malformed requests return 400 and unavailable RCON returns 409.
- Public coordinates remain tile anchors. Internal walking uses exact world positions.
- `act-move` and every target action use the same FIFO lock; crafting does not.
- Batches hold the lock, execute sequentially, and continue after per-target failures.
- No target-action Lua path may call `player.teleport`, `surface.create_entity`, or `player.mine_entity`.
- Build cursor preservation, placement, verification, restoration, and temporary-inventory destruction happen in one RCON command.
- Resource mining stops after one `amount` decrease, even while the resource entity remains valid.
- Insert/extract preserve current `LuaControl.insert` and `LuaControl.remove_item` automatic inventory selection.
- Pin runtime behavior to Factorio 2.0.73 documentation, not `/latest`.

---

## File Structure

- Create `src/agent-actions.ts`
  - Shared action types and stable errors.
  - FIFO lock.
  - Candidate generation and sorting.
  - `AgentActionController` batch/action state machines.
- Create `src/factorio-action-adapter.ts`
  - Factorio 2.0.73 probe and mutation command builders.
  - JSON parsing and `FactorioActionAdapter` implementation over injected RCON and movement functions.
- Modify `src/server.ts`
  - Split exact-world walking from public tile-centered movement.
  - Instantiate adapter/controller.
  - Replace six duplicated action loops and route public move through the controller lock.
  - Remove obsolete teleporting action command builders and simulated delays.
- Modify `src/agent-cli.ts`
  - Replace simulated-action help text with real approach/action behavior.
- Modify `package.json`
  - Add `npm test` using `tsx --test`.
- Create `test/agent-actions.test.ts`
  - Pure geometry, lock, orchestration, cleanup, batches, and resource-mining tests with a fake adapter.
- Create `test/factorio-action-adapter.test.ts`
  - Factorio 2.0.73 command-builder and parser contract tests.
- Modify `AGENTS.md`
  - Replace simulated-action operational notes with real action behavior and diagnostics.

---

### Task 1: Add The Test Harness, Shared Types, FIFO Lock, And Candidate Geometry

**Files:**
- Create: `src/agent-actions.ts`
- Create: `test/agent-actions.test.ts`
- Modify: `package.json:6-11`

**Interfaces:**
- Consumes: no new project interfaces.
- Produces: `Point`, `TilePoint`, `Box`, `EntityRef`, `WalkResult`, `CandidateAttempt`, `ApproachResult`, `ActionError`, `AsyncFifoLock`, `rotateBox`, and `generateApproachCandidates`.

- [ ] **Step 1: Add the test command**

Change the scripts object in `package.json` to:

```json
"scripts": {
  "dev": "tsx watch src/server.ts",
  "build": "tsc",
  "test": "tsx --test test/*.test.ts",
  "start": "node dist/server.js",
  "agent": "node dist/agent-cli.js"
}
```

- [ ] **Step 2: Create failing geometry and FIFO tests**

Create `test/agent-actions.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  AsyncFifoLock,
  generateApproachCandidates,
  rotateBox,
  type Box,
} from "../src/agent-actions.js";

test("rotateBox rotates a rectangular footprint for east-facing placement", () => {
  const box: Box = { left: -1, top: -0.5, right: 1, bottom: 0.5 };
  assert.deepEqual(rotateBox(box, 4), {
    left: -0.5,
    top: -1,
    right: 0.5,
    bottom: 1,
  });
});

test("generateApproachCandidates returns nearest clear positions first", () => {
  const result = generateApproachCandidates({
    player: { x: 5, y: 0 },
    box: { left: -1, top: -1, right: 1, bottom: 1 },
    reach: 3,
    clearance: 0.4,
  });
  assert.equal(result.length, 8);
  assert.ok(result[0].x > 1);
  assert.ok(Math.hypot(result[0].x - 5, result[0].y) <= Math.hypot(result[7].x - 5, result[7].y));
});

test("AsyncFifoLock runs queued work in submission order", async () => {
  const lock = new AsyncFifoLock();
  const order: number[] = [];
  const first = lock.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(1);
  });
  const second = lock.run(async () => {
    order.push(2);
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, [1, 2]);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`

Expected: FAIL because `src/agent-actions.ts` does not exist.

- [ ] **Step 4: Add the shared types, lock, and geometry implementation**

Create `src/agent-actions.ts` with these public contracts and implementations:

```ts
export type Point = { x: number; y: number };
export type TilePoint = Point;
export type Box = { left: number; top: number; right: number; bottom: number };

export type ActionError =
  | "invalid_target"
  | "no_character"
  | "no_entity"
  | "not_minable"
  | "missing_item"
  | "collision"
  | "invalid_position"
  | "blocked"
  | "out_of_reach"
  | "inventory_full"
  | "invalid_recipe"
  | "timeout"
  | "interrupted"
  | "verification_failed"
  | "cursor_restore_failed";

export type EntityRef = {
  requestedTile: TilePoint;
  name: string;
  type: string;
  unitNumber: number | null;
  position: Point;
  box: Box;
  amount: number | null;
};

export type WalkResult = {
  ok: boolean;
  reached: boolean;
  blocked: boolean;
  position: Point | null;
  target: Point;
  distanceRemaining: number | null;
  elapsedMs: number;
  steps: number;
  error?: string;
};

export type CandidateAttempt = {
  candidate: Point;
  movement: WalkResult;
  reachable: boolean;
  error?: "blocked" | "out_of_reach" | "interrupted";
};

export type ApproachResult = {
  ok: boolean;
  position: Point | null;
  chosen: Point | null;
  attempts: CandidateAttempt[];
  error?: ActionError;
};

export class AsyncFifoLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => current);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

export function rotateBox(box: Box, direction: number): Box {
  const normalized = ((direction % 16) + 16) % 16;
  if (normalized === 4 || normalized === 12) {
    return {
      left: box.top,
      top: box.left,
      right: box.bottom,
      bottom: box.right,
    };
  }
  return { ...box };
}

export function generateApproachCandidates(input: {
  player: Point;
  box: Box;
  reach: number;
  clearance: number;
}): Point[] {
  const { player, box, reach, clearance } = input;
  const inset = Math.max(clearance, Math.min(reach - 0.25, 1.5));
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const left = box.left - inset;
  const right = box.right + inset;
  const top = box.top - inset;
  const bottom = box.bottom + inset;
  return [
    { x: right, y: cy },
    { x: left, y: cy },
    { x: cx, y: bottom },
    { x: cx, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
    { x: right, y: top },
    { x: left, y: top },
  ].sort(
    (a, b) =>
      Math.hypot(a.x - player.x, a.y - player.y) -
      Math.hypot(b.x - player.x, b.y - player.y),
  );
}
```

- [ ] **Step 5: Run tests and build**

Run: `npm test`

Expected: 3 tests pass.

Run: `npm run build`

Expected: TypeScript compilation succeeds and does not emit `test/` into `dist/`.

- [ ] **Step 6: Commit**

```powershell
git add package.json src/agent-actions.ts test/agent-actions.test.ts
git commit -m "test: add action controller foundations"
```

---

### Task 2: Add Exact-World Movement And Put Public Move Under The FIFO Lock

**Files:**
- Modify: `src/agent-actions.ts`
- Modify: `src/server.ts:79-165, 2010-2150, 2604-2640`
- Modify: `test/agent-actions.test.ts`

**Interfaces:**
- Consumes: `AsyncFifoLock`, `Point`, and `WalkResult` from Task 1.
- Produces: `AgentActionController.runExclusive`, `AgentActionController.moveTiles`, and injected `walkToPoint(point)`.

- [ ] **Step 1: Add failing move serialization tests**

Append to `test/agent-actions.test.ts`:

```ts
import { AgentActionController, type ActionAdapter } from "../src/agent-actions.js";

function movementAdapter(events: string[]): ActionAdapter {
  return {
    async walkToPoint(target) {
      events.push(`walk:${target.x},${target.y}`);
      return {
        ok: true,
        reached: true,
        blocked: false,
        position: target,
        target,
        distanceRemaining: 0,
        elapsedMs: 1,
        steps: 1,
      };
    },
  } as ActionAdapter;
}

test("moveTiles converts public tile coordinates and shares the FIFO lock", async () => {
  const events: string[] = [];
  const controller = new AgentActionController(movementAdapter(events));
  await Promise.all([
    controller.moveTiles([{ x: 2, y: 3 }]),
    controller.runExclusive(async () => events.push("action")),
  ]);
  assert.deepEqual(events, ["walk:2.5,3.5", "action"]);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx tsx --test --test-name-pattern="moveTiles" test/*.test.ts`

Expected: FAIL because `ActionAdapter` and `AgentActionController` are not exported.

- [ ] **Step 3: Add the controller lock and movement contracts**

Append to `src/agent-actions.ts`:

```ts
export interface ActionAdapter {
  walkToPoint(target: Point): Promise<WalkResult>;
}

export class AgentActionController {
  private readonly lock = new AsyncFifoLock();

  constructor(private readonly adapter: ActionAdapter) {}

  runExclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.lock.run(work);
  }

  moveTiles(targets: TilePoint[]): Promise<WalkResult[]> {
    return this.runExclusive(async () => {
      const results: WalkResult[] = [];
      for (const target of targets) {
        results.push(
          await this.adapter.walkToPoint({ x: target.x + 0.5, y: target.y + 0.5 }),
        );
      }
      return results;
    });
  }
}
```

- [ ] **Step 4: Refactor the movement loop to exact world coordinates**

In `src/server.ts`, rename `walkAgentToTarget` to `walkAgentToPoint`, accept a validated `Point`, remove the internal `tileCenter` call, and return `target` unchanged:

```ts
async function walkAgentToPoint(target: Point): Promise<WalkToTargetResult> {
  const started = Date.now();
  let steps = 0;
  let position: Point | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestProgressAt = started;
  try {
    const startPosition = await probeAgentPlayerPosition();
    const expectedDistance = distanceBetween(startPosition, target);
    const timeoutMs = Math.max(
      AGENT_MOVE_MIN_TIMEOUT_MS,
      walkDelayMs(expectedDistance) + AGENT_MOVE_TIMEOUT_PADDING_MS,
    );
    position = startPosition;
    while (Date.now() - started <= timeoutMs) {
      const distance = distanceBetween(position, target);
      if (distance <= AGENT_MOVE_REACHED_DISTANCE) {
        await stopAgentWalking();
        return {
          x: target.x,
          y: target.y,
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
          x: target.x,
          y: target.y,
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
      if (direction === null) continue;
      await rconCommand(agentSetWalkingCommand(direction));
      steps += 1;
      await new Promise((resolve) => setTimeout(resolve, AGENT_MOVE_POLL_MS));
      position = await probeAgentPlayerPosition();
    }
    throw new Error("timeout");
  } catch (err: any) {
    await stopAgentWalking();
    return {
      x: target.x,
      y: target.y,
      ok: false,
      reached: false,
      blocked: err?.message === "blocked",
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

Keep raw coordinate parsing in the move route. Adapt `WalkToTargetResult` to `WalkResult` at the injected boundary; do not change the public response field names.

- [ ] **Step 5: Instantiate the controller and replace the move route loop**

After `walkAgentToPoint`, instantiate:

```ts
const actionController = new AgentActionController({
  async walkToPoint(target) {
    const result = await walkAgentToPoint(target);
    return {
      ok: result.ok,
      reached: result.reached,
      blocked: result.blocked,
      position: result.position,
      target: result.target,
      distanceRemaining: result.distance_remaining,
      elapsedMs: result.elapsed_ms,
      steps: result.steps,
      error: result.error,
    };
  },
});
```

In `/api/agent/act/move`, parse each coordinate with `parseMovementCoordinate`; return `invalid_target` per invalid entry; pass valid tile coordinates to `actionController.moveTiles`. Map camelCase controller fields back to the existing snake_case response fields.

- [ ] **Step 6: Run tests and build**

Run: `npm test`

Expected: all tests pass, including FIFO move serialization.

Run: `npm run build`

Expected: TypeScript compilation succeeds.

- [ ] **Step 7: Commit**

```powershell
git add src/agent-actions.ts src/server.ts test/agent-actions.test.ts
git commit -m "refactor: coordinate character movement actions"
```

---

### Task 3: Add Factorio Probes, Candidate Filtering, And Approach Fallback

**Files:**
- Create: `src/factorio-action-adapter.ts`
- Create: `test/factorio-action-adapter.test.ts`
- Modify: `src/agent-actions.ts`
- Modify: `test/agent-actions.test.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `Point`, `TilePoint`, `Box`, `EntityRef`, `WalkResult`, `generateApproachCandidates`.
- Produces: `PlayerSnapshot`, `BuildProbe`, expanded `ActionAdapter`, `FactorioActionAdapter`, `AgentActionController.approachEntity`, and `AgentActionController.approachBuild`.

- [ ] **Step 1: Add failing adapter command tests**

Create `test/factorio-action-adapter.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  entityProbeCommand,
  playerProbeCommand,
} from "../src/factorio-action-adapter.js";

test("playerProbeCommand reports surface, controller, reach, and position", () => {
  const command = playerProbeCommand();
  assert.match(command, /player\.connected/);
  assert.match(command, /player\.surface\.index/);
  assert.match(command, /player\.reach_distance/);
  assert.match(command, /rcon\.print/);
});

test("entityProbeCommand excludes characters and reports identity geometry", () => {
  const command = entityProbeCommand({ x: 3, y: 4 });
  assert.match(command, /e\.type ~= 'character'/);
  assert.match(command, /unit_number/);
  assert.match(command, /collision_box/);
  assert.match(command, /amount/);
});
```

- [ ] **Step 2: Add failing candidate fallback test**

Append a fake-adapter test where the first candidate returns `{blocked:true}` and the second returns reachable. Assert `approachEntity` returns `ok:true`, two attempts, and the second candidate as `chosen`.

Use this complete test body:

```ts
test("approachEntity tries the next clear candidate after a block", async () => {
  let walks = 0;
  const adapter = movementAdapter([]) as ActionAdapter;
  adapter.probePlayer = async () => ({
    connected: true,
    hasCharacter: true,
    surface: 1,
    controllerType: 1,
    position: { x: 5, y: 0 },
    reach: 3,
  });
  adapter.isCharacterClear = async () => true;
  adapter.canReachEntity = async () => walks === 2;
  adapter.walkToPoint = async (target) => {
    walks += 1;
    return {
      ok: walks === 2,
      reached: walks === 2,
      blocked: walks === 1,
      position: target,
      target,
      distanceRemaining: walks === 1 ? 1 : 0,
      elapsedMs: 1,
      steps: 1,
      error: walks === 1 ? "blocked" : undefined,
    };
  };
  const controller = new AgentActionController(adapter);
  const result = await controller.runExclusive(() =>
    controller.approachEntity({
      requestedTile: { x: 0, y: 0 },
      name: "stone-furnace",
      type: "furnace",
      unitNumber: 10,
      position: { x: 0.5, y: 0.5 },
      box: { left: -0.5, top: -0.5, right: 1.5, bottom: 1.5 },
      amount: null,
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(result.chosen, result.attempts[1].candidate);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`

Expected: FAIL for missing adapter command exports and approach methods.

- [ ] **Step 4: Define the expanded adapter contract**

Add to `src/agent-actions.ts`:

```ts
export type PlayerSnapshot = {
  connected: boolean;
  hasCharacter: boolean;
  surface: number;
  controllerType: number;
  position: Point;
  reach: number;
};

export type BuildProbe = {
  requestedTile: TilePoint;
  name: string;
  direction: number;
  footprint: Box;
  itemCount: number;
  surfacePlaceable: boolean;
  error?: ActionError;
};

export interface ActionAdapter {
  walkToPoint(target: Point): Promise<WalkResult>;
  probePlayer(): Promise<PlayerSnapshot>;
  probeEntity(target: TilePoint): Promise<EntityRef | null>;
  probeBuild(input: { name: string; x: number; y: number; direction: number }): Promise<BuildProbe>;
  isCharacterClear(point: Point): Promise<boolean>;
  canReachEntity(entity: EntityRef): Promise<boolean>;
  canReachBuild(probe: BuildProbe): Promise<boolean>;
}
```

- [ ] **Step 5: Implement approach fallback**

Add `approachEntity` and a private shared `approach` method to `AgentActionController`. The shared method must filter candidates with `isCharacterClear`, walk in sorted order, call the supplied reach predicate, collect every attempt, and return `blocked` only after candidates are exhausted.

```ts
async approachEntity(entity: EntityRef): Promise<ApproachResult> {
  const player = await this.adapter.probePlayer();
  if (!player.connected || !player.hasCharacter) {
    return { ok: false, position: null, chosen: null, attempts: [], error: "no_character" };
  }
  const candidates = generateApproachCandidates({
    player: player.position,
    box: entity.box,
    reach: player.reach,
    clearance: 0.4,
  });
  const attempts: CandidateAttempt[] = [];
  for (const candidate of candidates) {
    if (!(await this.adapter.isCharacterClear(candidate))) continue;
    const movement = await this.adapter.walkToPoint(candidate);
    if (!movement.ok) {
      attempts.push({ candidate, movement, reachable: false, error: "blocked" });
      continue;
    }
    const reachable = await this.adapter.canReachEntity(entity);
    attempts.push({
      candidate,
      movement,
      reachable,
      error: reachable ? undefined : "out_of_reach",
    });
    if (reachable) {
      return { ok: true, position: movement.position, chosen: candidate, attempts };
    }
  }
  return {
    ok: false,
    position: attempts.at(-1)?.movement.position ?? player.position,
    chosen: null,
    attempts,
    error: attempts.some((attempt) => attempt.error === "out_of_reach")
      ? "out_of_reach"
      : "blocked",
  };
}
```

Implement `approachBuild` explicitly:

```ts
async approachBuild(probe: BuildProbe): Promise<ApproachResult> {
  const player = await this.adapter.probePlayer();
  if (!player.connected || !player.hasCharacter) {
    return { ok: false, position: null, chosen: null, attempts: [], error: "no_character" };
  }
  const candidates = generateApproachCandidates({
    player: player.position,
    box: probe.footprint,
    reach: player.reach,
    clearance: 0.4,
  });
  const attempts: CandidateAttempt[] = [];
  for (const candidate of candidates) {
    if (!(await this.adapter.isCharacterClear(candidate))) continue;
    const movement = await this.adapter.walkToPoint(candidate);
    if (!movement.ok) {
      attempts.push({ candidate, movement, reachable: false, error: "blocked" });
      continue;
    }
    const reachable = await this.adapter.canReachBuild(probe);
    attempts.push({ candidate, movement, reachable, error: reachable ? undefined : "out_of_reach" });
    if (reachable) return { ok: true, position: movement.position, chosen: candidate, attempts };
  }
  return {
    ok: false,
    position: attempts.at(-1)?.movement.position ?? player.position,
    chosen: null,
    attempts,
    error: attempts.some((attempt) => attempt.error === "out_of_reach") ? "out_of_reach" : "blocked",
  };
}
```

- [ ] **Step 6: Implement the Factorio adapter probes**

Create `src/factorio-action-adapter.ts`. Export pure command builders plus:

```ts
export type ExecuteRcon = (command: string) => Promise<string>;

export class FactorioActionAdapter implements ActionAdapter {
  constructor(
    private readonly execute: ExecuteRcon,
    private readonly walk: (target: Point) => Promise<WalkResult>,
  ) {}

  walkToPoint(target: Point): Promise<WalkResult> {
    return this.walk(target);
  }

  async probePlayer(): Promise<PlayerSnapshot> {
    return parseJson<PlayerSnapshot>(await this.execute(playerProbeCommand()));
  }

  async probeEntity(target: TilePoint): Promise<EntityRef | null> {
    return parseJson<EntityRef | null>(await this.execute(entityProbeCommand(target)));
  }

  async probeBuild(input: {
    name: string;
    x: number;
    y: number;
    direction: number;
  }): Promise<BuildProbe> {
    return parseJson<BuildProbe>(
      await this.execute(buildProbeCommand(input)),
    );
  }

  async isCharacterClear(point: Point): Promise<boolean> {
    return parseJson<{ clear: boolean }>(await this.execute(characterClearCommand(point))).clear;
  }

  async canReachEntity(entity: EntityRef): Promise<boolean> {
    return parseJson<{ reachable: boolean }>(
      await this.execute(entityReachCommand(entity)),
    ).reachable;
  }

  async canReachBuild(probe: BuildProbe): Promise<boolean> {
    return parseJson<{ reachable: boolean }>(
      await this.execute(buildReachCommand(probe)),
    ).reachable;
  }
}
```

Every entity command must resolve by requested tile, then verify `name` and `unit_number` when non-null. `entityProbeCommand` must skip `character` entities before choosing a target. Serialize numbers and strings with existing `luaString` behavior copied into this module as a private helper.

- [ ] **Step 7: Inject the real adapter**

In `src/server.ts`, replace the temporary movement-only adapter with:

```ts
const factorioActionAdapter = new FactorioActionAdapter(
  rconCommand,
  async (target) => mapWalkResult(await walkAgentToPoint(target)),
);
const actionController = new AgentActionController(factorioActionAdapter);
```

- [ ] **Step 8: Run tests and build**

Run: `npm test`

Expected: all geometry, lock, command, and candidate fallback tests pass.

Run: `npm run build`

Expected: TypeScript compilation succeeds.

- [ ] **Step 9: Commit**

```powershell
git add src/agent-actions.ts src/factorio-action-adapter.ts src/server.ts test/agent-actions.test.ts test/factorio-action-adapter.test.ts
git commit -m "feat: add real action approach controller"
```

---

### Task 4: Replace Direct Entity Creation With Atomic Cursor Building

**Files:**
- Modify: `src/agent-actions.ts`
- Modify: `src/factorio-action-adapter.ts`
- Modify: `src/server.ts:798-929, 2415-2501`
- Modify: `test/agent-actions.test.ts`
- Modify: `test/factorio-action-adapter.test.ts`

**Interfaces:**
- Consumes: `BuildProbe`, approach fallback, FIFO lock, and `FactorioActionAdapter`.
- Produces: `BuildRequest`, `BuildOperationResult`, `ActionAdapter.build`, and `AgentActionController.buildBatch`.

- [ ] **Step 1: Add failing atomic build command tests**

Add the following command-contract test for `buildCommand(request)`.

```ts
test("buildCommand performs one atomic cursor transaction", () => {
  const command = buildCommand({ name: "stone-furnace", x: 3, y: 4, direction: 0 });
  for (const token of [
    "game.create_inventory(1)",
    "cursor.swap_stack",
    "player.can_build_from_cursor",
    "player.build_from_cursor",
    "temp.destroy()",
    "requested_tile",
    "actual_position",
    "collision_box",
  ]) assert.match(command, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(command, /teleport|s\.create_entity/);
});
```

- [ ] **Step 2: Add failing build orchestration tests**

Add this batch-continuation test; add separate cases by changing the fake results to `verification_failed` and `cursor_restore_failed`:

```ts
test("buildBatch continues after a missing item", async () => {
  const adapter = {
    async probeBuild(request: BuildRequest) {
      return {
        requestedTile: { x: request.x, y: request.y },
        name: request.name,
        direction: request.direction,
        footprint: { left: request.x, top: request.y, right: request.x + 1, bottom: request.y + 1 },
        itemCount: request.name === "missing" ? 0 : 1,
        surfacePlaceable: true,
      };
    },
    async build(request: BuildRequest) {
      return {
        ok: true,
        requestedTile: { x: request.x, y: request.y },
        actualPosition: { x: request.x + 0.5, y: request.y + 0.5 },
        collisionBox: { left: request.x, top: request.y, right: request.x + 1, bottom: request.y + 1 },
        direction: request.direction,
        consumed: 1,
        cursorRestored: true,
      };
    },
  } as ActionAdapter;
  const controller = new AgentActionController(adapter);
  const results = await controller.buildBatch([
    { name: "missing", x: 1, y: 1, direction: 0 },
    { name: "stone-furnace", x: 2, y: 2, direction: 0 },
  ]);
  assert.equal(results[0].error, "missing_item");
  assert.equal(results[1].ok, true);
});
```

- [ ] **Step 3: Run focused tests to verify they fail**

Run: `npx tsx --test --test-name-pattern="build" test/*.test.ts`

Expected: FAIL for missing build contracts.

- [ ] **Step 4: Add build contracts and controller method**

Add:

```ts
export type BuildRequest = { name: string; x: number; y: number; direction: number };
export type BuildOperationResult = {
  ok: boolean;
  requestedTile: TilePoint;
  actualPosition: Point | null;
  collisionBox: Box | null;
  direction: number | null;
  consumed: number;
  cursorRestored: boolean;
  error?: ActionError;
  detail?: string;
};
```

Extend `ActionAdapter` with `build(request): Promise<BuildOperationResult>` and `verifyBuild(request): Promise<BuildOperationResult>`. Implement `buildBatch` as one `runExclusive` loop: validate, `probeBuild`, fail on `itemCount < 1` or `surfacePlaceable=false`, approach, call atomic build, read-only verify, merge approach diagnostics, and continue.

- [ ] **Step 5: Implement the atomic Factorio 2.0.73 build command**

Build the Lua command in this exact order: resolve connected player/cursor; create one-slot temporary inventory; swap existing cursor into temp; remove one requested item from player; set cursor; call `can_build_from_cursor`; call `build_from_cursor`; find the expected entity at requested tile; capture actual position/direction/collision box; move requested leftovers back to player; swap saved cursor back; if restoration fails, retain the saved stack in temp and report `cursor_restore_failed`; destroy temp only when empty; print one JSON result.

Keep the whole transaction inside one `buildCommand` invocation. Use `pcall` plus an explicit cleanup function, and invoke cleanup before every return.

- [ ] **Step 6: Replace the build route**

Delete `agentBuildCommand` from `src/server.ts`. Replace its probe/delay/command loop with:

```ts
const results = await actionController.buildBatch(
  trimmed.map((entity) => ({
    name: String(entity.name),
    x: Number(entity.x),
    y: Number(entity.y),
    direction: Number(entity.direction ?? 0),
  })),
);
return json(res, 200, {
  ok: true,
  data: { results },
  truncated: entities.length > trimmed.length,
});
```

- [ ] **Step 7: Run tests, forbidden-call scan, and build**

Run: `npm test`

Expected: build tests and all previous tests pass.

Run: `rg -n "agentBuildCommand|s\.create_entity|player\.teleport" src/server.ts src/factorio-action-adapter.ts`

Expected: no build-action matches; unrelated world/bootstrap creation may remain in `src/server.ts` and must be inspected by line rather than deleted.

Run: `npm run build`

Expected: TypeScript compilation succeeds.

- [ ] **Step 8: Commit**

```powershell
git add src/agent-actions.ts src/factorio-action-adapter.ts src/server.ts test/agent-actions.test.ts test/factorio-action-adapter.test.ts
git commit -m "feat: build entities through player cursor"
```

---

### Task 5: Replace Instant Mining With Timed Single-Cycle Mining

**Files:**
- Modify: `src/agent-actions.ts`
- Modify: `src/factorio-action-adapter.ts`
- Modify: `src/server.ts:930-1059, 2502-2603`
- Modify: `test/agent-actions.test.ts`
- Modify: `test/factorio-action-adapter.test.ts`

**Interfaces:**
- Consumes: entity approach and FIFO lock.
- Produces: `MiningSnapshot`, `ActionAdapter.pulseMining`, `ActionAdapter.stopMining`, and `AgentActionController.mineBatch`.

- [ ] **Step 1: Add failing mining command tests**

Add this mining command test:

```ts
test("mining commands use timed character mining state", () => {
  const pulse = pulseMiningCommand({
    requestedTile: { x: 1, y: 2 },
    name: "iron-ore",
    type: "resource",
    unitNumber: null,
    position: { x: 1.5, y: 2.5 },
    box: { left: 1, top: 2, right: 2, bottom: 3 },
    amount: 1000,
  });
  assert.match(pulse, /update_selected_entity/);
  assert.match(pulse, /mining_state/);
  assert.match(pulse, /character_mining_progress/);
  assert.doesNotMatch(pulse, /mine_entity|teleport/);
  assert.match(stopMiningCommand(), /mining=false/);
});
```

- [ ] **Step 2: Add failing controller tests for both completion modes**

Add explicit completion-predicate tests:

```ts
test("miningCycleComplete handles entity removal and one resource decrement", () => {
  const furnace: MiningSnapshot = {
    targetValid: true, targetName: "stone-furnace", targetType: "furnace",
    unitNumber: 7, amount: null, progress: 0, playerItemCount: 0,
  };
  assert.equal(miningCycleComplete(furnace, { ...furnace, targetValid: false }), true);
  const ore: MiningSnapshot = {
    targetValid: true, targetName: "iron-ore", targetType: "resource",
    unitNumber: null, amount: 1000, progress: 0, playerItemCount: 0,
  };
  assert.equal(miningCycleComplete(ore, { ...ore, amount: 999 }), true);
  assert.equal(miningCycleComplete(ore, { ...ore, progress: 0.9 }), false);
});
```

Add a controller cleanup test whose fake `pulseMining` throws `new Error("rcon_lost")`; assert the promise rejects and a `stopMining` counter equals one.

- [ ] **Step 3: Run focused tests to verify they fail**

Run: `npx tsx --test --test-name-pattern="mining|resource" test/*.test.ts`

Expected: FAIL for missing mining contracts.

- [ ] **Step 4: Add mining contracts and completion predicate**

```ts
export type MiningSnapshot = {
  targetValid: boolean;
  targetName: string;
  targetType: string;
  unitNumber: number | null;
  amount: number | null;
  progress: number;
  playerItemCount: number;
};

export function miningCycleComplete(
  initial: MiningSnapshot,
  current: MiningSnapshot,
): boolean {
  if (!current.targetValid) return true;
  if (initial.targetType === "resource") {
    return (
      initial.amount !== null &&
      current.amount !== null &&
      current.amount < initial.amount
    );
  }
  return false;
}
```

Extend `ActionAdapter` with `pulseMining(entity,itemName)`, `stopMining()`, and `restoreSelection(entity|null)`. Implement `mineBatch` with a 50 ms pulse/poll loop, progress-based stall detection, action timeout, and `finally` cleanup. Reject `character` and non-minable targets before approach.

- [ ] **Step 5: Implement Factorio mining commands**

`pulseMiningCommand` must resolve and verify the original entity, call `player.update_selected_entity(entity.position)`, set `player.mining_state={mining=true,position=entity.position}`, and return the full `MiningSnapshot`. `stopMiningCommand` sets `mining=false`. Use `player.character_mining_progress` for Factorio 2.0.73.

- [ ] **Step 6: Replace the mine route and delete simulated timing**

Delete `agentMineCommand`, its `player.mine_entity` call, and the post-action `minedCount * 2000` wait. Route valid targets through `actionController.mineBatch` and preserve the current envelope/truncation behavior.

- [ ] **Step 7: Run tests, forbidden-call scan, and build**

Run: `npm test`

Expected: all tests pass, including resource amount decrease and cleanup.

Run: `rg -n "player\.mine_entity|postDelayMs|agentMineCommand" src`

Expected: no matches.

Run: `npm run build`

Expected: TypeScript compilation succeeds.

- [ ] **Step 8: Commit**

```powershell
git add src/agent-actions.ts src/factorio-action-adapter.ts src/server.ts test/agent-actions.test.ts test/factorio-action-adapter.test.ts
git commit -m "feat: mine entities through character state"
```

---

### Task 6: Migrate Rotate And Set-Recipe To Real Approach And Verification

**Files:**
- Modify: `src/agent-actions.ts`
- Modify: `src/factorio-action-adapter.ts`
- Modify: `src/server.ts:1133-1349, 2641-2828`
- Modify: `test/agent-actions.test.ts`
- Modify: `test/factorio-action-adapter.test.ts`

**Interfaces:**
- Consumes: entity approach, identity-safe probes, and FIFO lock.
- Produces: `RotateOperationResult`, `RecipeOperationResult`, `rotateBatch`, and `setRecipeBatch`.

- [ ] **Step 1: Add failing verification tests**

Add these operation-result tests:

```ts
test("rotate result requires a direction change", () => {
  assert.equal(verifyRotation({ ok: true, before: 0, after: 4 }).ok, true);
  assert.equal(
    verifyRotation({ ok: true, before: 0, after: 0 }).error,
    "verification_failed",
  );
});

test("recipe result requires exact readback", () => {
  assert.equal(
    verifyRecipe({ ok: true, requested: "iron-gear-wheel", before: null, after: "iron-gear-wheel" }).ok,
    true,
  );
  assert.equal(
    verifyRecipe({ ok: true, requested: "iron-gear-wheel", before: null, after: null }).error,
    "verification_failed",
  );
  assert.equal(
    verifyRecipe({ ok: false, requested: "missing", before: null, after: null, error: "invalid_recipe" }).error,
    "invalid_recipe",
  );
});
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `npx tsx --test --test-name-pattern="rotate|recipe" test/*.test.ts`

Expected: FAIL for missing contracts.

- [ ] **Step 3: Add adapter and controller operations**

Define:

```ts
export type RotateOperationResult = {
  ok: boolean;
  before: number;
  after: number;
  error?: ActionError;
};

export type RecipeOperationResult = {
  ok: boolean;
  requested: string;
  before: string | null;
  after: string | null;
  error?: ActionError;
};

export function verifyRotation(result: RotateOperationResult): RotateOperationResult {
  if (!result.ok || result.before !== result.after) return result;
  return { ...result, ok: false, error: "verification_failed" };
}

export function verifyRecipe(result: RecipeOperationResult): RecipeOperationResult {
  if (!result.ok || result.requested === result.after) return result;
  return { ...result, ok: false, error: "verification_failed" };
}
```

Add `rotate(entity)` and `setRecipe(entity,recipe)` to `ActionAdapter`. Controller methods must probe, approach, invoke, verify returned state, attach candidate diagnostics, and continue batches.

- [ ] **Step 4: Replace Lua commands with no-teleport primitives**

Move command builders into `src/factorio-action-adapter.ts`. Remove each `ensure_reach` and `player.teleport` block. Commands must independently verify current `player.can_reach_entity(entity)` before mutation and return `out_of_reach` if the state changed after approach.

- [ ] **Step 5: Replace both routes**

Replace probe/simulated-delay loops with `actionController.rotateBatch` and `actionController.setRecipeBatch`; preserve filters, envelopes, and truncation.

- [ ] **Step 6: Run tests and build**

Run: `npm test`

Expected: all tests pass.

Run: `npm run build`

Expected: TypeScript compilation succeeds.

- [ ] **Step 7: Commit**

```powershell
git add src/agent-actions.ts src/factorio-action-adapter.ts src/server.ts test/agent-actions.test.ts test/factorio-action-adapter.test.ts
git commit -m "feat: approach entities for configuration actions"
```

---

### Task 7: Migrate Insert And Extract With Lossless Partial Transfers

**Files:**
- Modify: `src/agent-actions.ts`
- Modify: `src/factorio-action-adapter.ts`
- Modify: `src/server.ts:1350-1480, 2867-3025`
- Modify: `test/agent-actions.test.ts`
- Modify: `test/factorio-action-adapter.test.ts`

**Interfaces:**
- Consumes: entity approach, FIFO lock, and current request shapes.
- Produces: `TransferResult`, `insert`, `extract`, `insertOne`, and `extractOne`.

- [ ] **Step 1: Add failing transfer tests**

Add this table-driven conservation test:

```ts
test("transfer results conserve items", () => {
  const results: TransferResult[] = [
    { ok: true, requested: 10, available: 10, removedFromSource: 10, insertedIntoDestination: 10, returnedToSource: 0, partial: false },
    { ok: true, requested: 10, available: 10, removedFromSource: 10, insertedIntoDestination: 4, returnedToSource: 6, partial: true },
    { ok: true, requested: "all", available: 7, removedFromSource: 7, insertedIntoDestination: 0, returnedToSource: 7, partial: true },
  ];
  for (const result of results) {
    assert.equal(
      result.removedFromSource,
      result.insertedIntoDestination + result.returnedToSource,
    );
  }
});
```

- [ ] **Step 2: Add failing command tests**

Add this command-contract test:

```ts
test("transfer commands recheck reach and return rejected items", () => {
  const sampleFurnace: EntityRef = {
    requestedTile: { x: 1, y: 2 },
    name: "stone-furnace",
    type: "furnace",
    unitNumber: 9,
    position: { x: 1.5, y: 2.5 },
    box: { left: 1, top: 2, right: 2, bottom: 3 },
    amount: null,
  };
  const insert = insertCommand({ entity: sampleFurnace, item: "coal", count: 10 });
  const extract = extractCommand({ entity: sampleFurnace, item: "iron-plate", count: "all" });
  assert.match(insert, /player\.can_reach_entity/);
  assert.match(insert, /e\.insert/);
  assert.match(extract, /player\.can_reach_entity/);
  assert.match(extract, /e\.remove_item/);
  assert.match(extract, /e\.insert/);
  assert.doesNotMatch(`${insert}${extract}`, /teleport/);
});
```

- [ ] **Step 3: Run focused tests to verify they fail**

Run: `npx tsx --test --test-name-pattern="insert|extract|transfer" test/*.test.ts`

Expected: FAIL for missing transfer contracts.

- [ ] **Step 4: Add transfer contracts and controller methods**

```ts
export type TransferResult = {
  ok: boolean;
  requested: number | "all";
  available: number;
  removedFromSource: number;
  insertedIntoDestination: number;
  returnedToSource: number;
  partial: boolean;
  error?: ActionError;
};
```

Add adapter methods `insert(entity,item,count)` and `extract(entity,item,count)`. `insertOne` and `extractOne` must probe, approach, invoke one atomic transfer command, verify conservation, and attach movement diagnostics.

- [ ] **Step 5: Implement atomic transfer commands**

Insert command: get player total; remove up to requested count; call `e.insert`; return rejected count with `player.insert`; report all counts and `partial`.

Extract command: get entity total; normalize `all`; remove up to requested count; call `player.insert`; return rejected count with `e.insert`; report all counts and `partial`.

Both commands preserve automatic inventory selection through `LuaControl.insert/remove_item` and independently recheck reach immediately before transfer.

- [ ] **Step 6: Replace routes and remove delays/teleports**

Replace insert/extract probe and delay blocks with the controller methods. Keep their single-result `{ok:true,data}` envelopes and current CLI request shapes.

- [ ] **Step 7: Run tests, scan, and build**

Run: `npm test`

Expected: all tests pass and every conservation assertion holds.

Run: `rg -n "walkDelayMs\(distance\)|ensure_reach|player\.teleport" src/server.ts src/factorio-action-adapter.ts`

Expected: no target-action matches. `walkDelayMs` remains only for real movement timeout estimation.

Run: `npm run build`

Expected: TypeScript compilation succeeds.

- [ ] **Step 8: Commit**

```powershell
git add src/agent-actions.ts src/factorio-action-adapter.ts src/server.ts test/agent-actions.test.ts test/factorio-action-adapter.test.ts
git commit -m "feat: transfer items through reachable entities"
```

---

### Task 8: Update Agent Guidance And Run Live Factorio Regression

**Files:**
- Modify: `src/agent-cli.ts:88-92, 161-218`
- Modify: `AGENTS.md:58-64`
- Test: live Factorio server and connected graphical client

**Interfaces:**
- Consumes: all completed action endpoints.
- Produces: accurate CLI help and operational guidance.

- [ ] **Step 1: Add a CLI help regression test**

Create `test/agent-cli-help.test.ts` that runs the TypeScript CLI through the existing `tsx` loader and asserts output contains `physically walks`, does not contain `simulated walking`, and repeats for mine/rotate/set-recipe/insert/extract.

```ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

for (const command of ["act-build", "act-mine", "act-rotate", "act-set-recipe", "act-insert", "act-extract"]) {
  test(`${command} help describes real action movement`, () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/agent-cli.ts", "help", command], {
      encoding: "utf8",
    });
    assert.match(output, /physically walks/i);
    assert.doesNotMatch(output, /simulated walking/i);
  });
}
```

- [ ] **Step 2: Run build and focused test to verify it fails**

Run: `npm run build`

Expected: build succeeds.

Run: `npx tsx --test --test-name-pattern="help describes" test/*.test.ts`

Expected: FAIL because old help still says simulated walking.

- [ ] **Step 3: Update CLI and AGENTS guidance**

Replace all six simulated-walking notes with: `This action physically walks into reach, performs the Factorio action, and may return blocked or out_of_reach diagnostics.`

In `AGENTS.md`, state that move and target actions are serialized, actions may take real game time, batches continue after failures, and every result must be verified with observe commands.

- [ ] **Step 4: Run automated verification**

Run: `npm run build`

Expected: TypeScript compilation succeeds.

Run: `npm test`

Expected: all tests pass.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 5: Start and verify the live server**

Run: `npm run start`

In another shell:

```powershell
npm run agent -- server-start -- --save codex.zip
npm run agent -- server-status
npm run agent -- observe-player -- --limit-inventory 80 --limit-equipment 10
```

Expected: Factorio is running, RCON is connected, and the joined player is visible.

- [ ] **Step 6: Verify build and cursor restoration live**

Choose an open nearby tile and an inventory item. Hold a different item in the graphical client cursor, run `act-build`, and observe physical walking plus placement. Verify the held item is restored and `observe-entity` reports requested tile, actual center, direction, and collision box.

- [ ] **Step 7: Verify timed mining and resource single-cycle behavior live**

Run `act-mine` on one placed entity and one resource tile while watching. Verify normal-duration mining, no teleport, cleanup, and exactly one resource amount decrease.

- [ ] **Step 8: Verify interactions and candidate failures live**

Run rotate, set-recipe, insert, and extract from outside reach; confirm physical approach and verified state changes. Test a blocked first candidate with an open alternative, then a fully blocked target and inspect all attempted-candidate diagnostics.

- [ ] **Step 9: Commit**

```powershell
git add src/agent-cli.ts AGENTS.md test/agent-cli-help.test.ts
git commit -m "docs: describe real character actions"
```

---

## Final Verification

- [ ] Run `npm run build`; expect success.
- [ ] Run `npm test`; expect all tests to pass.
- [ ] Run `git diff --check`; expect no output.
- [ ] Run `rg -n "player\.teleport|surface\.create_entity|player\.mine_entity|simulated walking" src/agent-actions.ts src/factorio-action-adapter.ts src/agent-cli.ts`; expect no matches.
- [ ] Confirm `walkDelayMs` is used only to estimate real movement timeout.
- [ ] Confirm live build, mine, rotate, set-recipe, insert, extract, blocked fallback, full blockage, cursor restoration, resource single-cycle mining, partial transfer, and `act-move` serialization checks are recorded in the implementation run report.
