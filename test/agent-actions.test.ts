import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentActionController,
  AsyncFifoLock,
  generateApproachCandidates,
  rotateBox,
  type ActionAdapter,
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
