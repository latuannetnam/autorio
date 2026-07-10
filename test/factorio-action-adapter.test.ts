import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCommand,
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
