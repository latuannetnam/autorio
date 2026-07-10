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
