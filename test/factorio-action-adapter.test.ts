import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCommand,
  entityProbeCommand,
  extractCommand,
  insertCommand,
  playerProbeCommand,
  pulseMiningCommand,
  stopMiningCommand,
} from "../src/factorio-action-adapter.js";
import type { EntityRef } from "../src/agent-actions.js";

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

test("mining commands use timed character mining state", () => {
  const sampleEntity: EntityRef = {
    requestedTile: { x: 1, y: 2 },
    name: "iron-ore",
    type: "resource",
    unitNumber: null,
    position: { x: 1.5, y: 2.5 },
    box: { left: 1, top: 2, right: 2, bottom: 3 },
    amount: 1000,
  };
  const pulse = pulseMiningCommand(sampleEntity, "iron-ore");
  assert.match(pulse, /update_selected_entity/);
  assert.match(pulse, /mining_state/);
  assert.match(pulse, /character_mining_progress/);
  assert.doesNotMatch(pulse, /mine_entity|teleport/);
  assert.match(stopMiningCommand(), /mining=false/);
});

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
