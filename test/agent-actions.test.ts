import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentActionController,
  AsyncFifoLock,
  generateApproachCandidates,
  miningCycleComplete,
  rotateBox,
  verifyRecipe,
  verifyRotation,
  type ActionAdapter,
  type Box,
  type BuildRequest,
  type MiningSnapshot,
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

test("buildBatch continues after a missing item", async () => {
  const adapter = {
    async probePlayer() {
      return {
        connected: true,
        hasCharacter: true,
        surface: 1,
        controllerType: 1,
        position: { x: 5, y: 5 },
        reach: 5,
      };
    },
    async isCharacterClear() {
      return true;
    },
    async canReachBuild() {
      return true;
    },
    async walkToPoint(target) {
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
    async verifyBuild(request: BuildRequest) {
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

test("miningCycleComplete handles entity removal and one resource decrement", () => {
  const furnace: MiningSnapshot = {
    targetValid: true,
    targetName: "stone-furnace",
    targetType: "furnace",
    unitNumber: 7,
    amount: null,
    progress: 0,
    playerItemCount: 0,
  };
  assert.equal(miningCycleComplete(furnace, { ...furnace, targetValid: false }), true);
  const ore: MiningSnapshot = {
    targetValid: true,
    targetName: "iron-ore",
    targetType: "resource",
    unitNumber: null,
    amount: 1000,
    progress: 0,
    playerItemCount: 0,
  };
  assert.equal(miningCycleComplete(ore, { ...ore, amount: 999 }), true);
  assert.equal(miningCycleComplete(ore, { ...ore, progress: 0.9 }), false);
});

test("mineBatch calls stopMining on adapter pulse failure", async () => {
  let stopCount = 0;
  const adapter = {
    async probePlayer() {
      return {
        connected: true,
        hasCharacter: true,
        surface: 1,
        controllerType: 1,
        position: { x: 5, y: 5 },
        reach: 5,
      };
    },
    async isCharacterClear() {
      return true;
    },
    async canReachEntity() {
      return true;
    },
    async walkToPoint(target) {
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
    async probeEntity() {
      return {
        requestedTile: { x: 0, y: 0 },
        name: "iron-ore",
        type: "resource",
        unitNumber: null,
        position: { x: 0.5, y: 0.5 },
        box: { left: 0, top: 0, right: 1, bottom: 1 },
        amount: 100,
      };
    },
    async pulseMining() {
      throw new Error("rcon_lost");
    },
    async stopMining() {
      stopCount += 1;
    },
    async restoreSelection() {},
  } as ActionAdapter;
  const controller = new AgentActionController(adapter);
  await assert.rejects(
    controller.mineBatch([{ x: 0, y: 0 }]),
    /rcon_lost/,
  );
  assert.equal(stopCount, 1);
});

test("rotate result requires a direction change", () => {
  assert.equal(verifyRotation({ ok: true, before: 0, after: 4 }).ok, true);
  assert.equal(
    verifyRotation({ ok: true, before: 0, after: 0 }).error,
    "verification_failed",
  );
});

test("recipe result requires exact readback", () => {
  assert.equal(
    verifyRecipe({
      ok: true,
      requested: "iron-gear-wheel",
      before: null,
      after: "iron-gear-wheel",
    }).ok,
    true,
  );
  assert.equal(
    verifyRecipe({
      ok: true,
      requested: "iron-gear-wheel",
      before: null,
      after: null,
    }).error,
    "verification_failed",
  );
  assert.equal(
    verifyRecipe({
      ok: false,
      requested: "missing",
      before: null,
      after: null,
      error: "invalid_recipe",
    }).error,
    "invalid_recipe",
  );
});

