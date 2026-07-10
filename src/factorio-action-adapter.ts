import type {
  ActionAdapter,
  BuildOperationResult,
  BuildProbe,
  BuildRequest,
  EntityRef,
  MiningSnapshot,
  PlayerSnapshot,
  Point,
  RecipeOperationResult,
  RotateOperationResult,
  TilePoint,
  WalkResult,
} from "./agent-actions.js";

export type ExecuteRcon = (command: string) => Promise<string>;

function luaString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function luaNumber(value: number): string {
  return Number.isFinite(value) ? value.toString() : "0";
}

export function playerProbeCommand(): string {
  return [
    "(function()",
    "  local player = game.get_player(1) or (game.connected_players and game.connected_players[1])",
    "  if not player then rcon.print('{}') return end",
    "  local connected = player.connected == true",
    "  local has_character = player.character ~= nil",
    "  local pos = player.position or {x=0, y=0}",
    "  local data = {",
    "    connected = connected,",
    "    has_character = has_character,",
    "    surface = (player.surface and player.surface.index) or 0,",
    "    controller_type = player.controller_type and player.controller_type or 'player',",
    "    position = { x = pos.x, y = pos.y },",
    "    reach_distance = player.reach_distance or 0,",
    "  }",
    "  rcon.print(game.table_to_json(data))",
    "end)()",
  ].join("\n");
}

export function entityProbeCommand(target: TilePoint): string {
  const x = luaNumber(target.x);
  const y = luaNumber(target.y);
  return [
    "(function()",
    `  local target = {x = ${x}, y = ${y}}`,
    "  local surface = game.get_player(1) and game.get_player(1).surface or game.surfaces[1]",
    "  if not surface then rcon.print('null') return end",
    "  local function find_entity()",
    "    local ents = surface.find_entities_filtered{area={{target.x-0.5, target.y-0.5}, {target.x+0.5, target.y+0.5}}}",
    "    for _, e in ipairs(ents) do",
    "      if e.type ~= 'character' then",
    "        return e",
    "      end",
    "    end",
    "    local fallback = surface.get_entity(target) or surface.find_entity('character', target)",
    "    return fallback",
    "  end",
    "  local e = find_entity()",
    "  if not e then rcon.print('null') return end",
    "  if e.type == 'character' then rcon.print('null') return end",
    "  local pos = e.position",
    "  local box = e.collision_box or {left_top = {x=0, y=0}, right_bottom = {x=0, y=0}}",
    "  local lt = box.left_top or {x=0, y=0}",
    "  local rb = box.right_bottom or {x=0, y=0}",
    "  local data = {",
    "    requested_tile = { x = target.x, y = target.y },",
    "    name = e.name or '',",
    "    type = e.type or '',",
    "    unit_number = e.unit_number,",
    "    position = { x = pos.x, y = pos.y },",
    "    box = { left = lt.x, top = lt.y, right = rb.x, bottom = rb.y },",
    "    amount = (e.amount ~= nil) and e.amount or nil,",
    "  }",
    "  rcon.print(game.table_to_json(data))",
    "end)()",
  ].join("\n");
}

export function characterClearCommand(point: Point): string {
  const x = luaNumber(point.x);
  const y = luaNumber(point.y);
  return [
    "(function()",
    "  local player = game.get_player(1) or (game.connected_players and game.connected_players[1])",
    "  if not player or not player.character then rcon.print('{\"clear\":false}') return end",
    "  local surface = player.surface",
    `  local p = {x = ${x}, y = ${y}}`,
    "  local found = surface.find_entities_filtered{area={{p.x-0.4, p.y-0.4}, {p.x+0.4, p.y+0.4}}}",
    "  for _, e in ipairs(found) do",
    "    if e.type == 'character' and e ~= player.character then",
    "      rcon.print('{\"clear\":false}') return",
    "    end",
    "    if e.collides_with_player and e ~= player.character then",
    "      rcon.print('{\"clear\":false}') return",
    "    end",
    "  end",
    "  rcon.print('{\"clear\":true}')",
    "end)()",
  ].join("\n");
}

export function entityReachCommand(entity: EntityRef): string {
  const name = luaString(entity.name);
  const tx = luaNumber(entity.requestedTile.x);
  const ty = luaNumber(entity.requestedTile.y);
  const unit = entity.unitNumber === null
    ? "nil"
    : luaNumber(entity.unitNumber);
  return [
    "(function()",
    "  local player = game.get_player(1) or (game.connected_players and game.connected_players[1])",
    "  if not player or not player.character then rcon.print('{\"reachable\":false}') return end",
    `  local target = {x = ${tx}, y = ${ty}}`,
    `  local expected_name = ${name}`,
    `  local expected_unit = ${unit}`,
    "  local surface = player.surface",
    "  local function get_entity()",
    "    local ents = surface.find_entities_filtered{area={{target.x-0.5, target.y-0.5}, {target.x+0.5, target.y+0.5}}}",
    "    for _, e in ipairs(ents) do",
    "      if e.type ~= 'character' then return e end",
    "    end",
    "    return surface.get_entity(target)",
    "  end",
    "  local e = get_entity()",
    "  if not e then rcon.print('{\"reachable\":false}') return end",
    "  if expected_unit and e.unit_number ~= expected_unit then rcon.print('{\"reachable\":false}') return end",
    "  local ok = player.can_reach_entity(e)",
    "  rcon.print(string.format('{\"reachable\":%s}', tostring(ok)))",
    "end)()",
  ].join("\n");
}

export function buildProbeCommand(input: {
  name: string;
  x: number;
  y: number;
  direction: number;
}): string {
  const name = luaString(input.name);
  const x = luaNumber(input.x);
  const y = luaNumber(input.y);
  const direction = luaNumber(input.direction);
  return [
    "(function()",
    "  local player = game.get_player(1) or (game.connected_players and game.connected_players[1])",
    "  if not player or not player.character then",
    "    rcon.print('{\"error\":\"no_character\"}') return",
    "  end",
    `  local entity_name = ${name}`,
    `  local position = {x = ${x}, y = ${y}}`,
    `  local direction = ${direction}`,
    "  local proto = prototypes.entity[entity_name]",
    "  if not proto then",
    "    rcon.print(string.format('{\"error\":\"%s\"}', 'invalid_target')) return",
    "  end",
    "  local item_name = proto.place_result and proto.place_result.name or entity_name",
    "  local count = player.get_item_count(item_name) or 0",
    "  local surface = player.surface",
    "  local surface_placeable = (proto.surface_conditions == nil) and true or false",
    "  if surface.can_place_entity{",
    "    name = entity_name,",
    "    position = position,",
    "    direction = direction,",
    "    force = player.force,",
    "  } then surface_placeable = true end",
    "  local box = proto.collision_box or {left_top = {x=0, y=0}, right_bottom = {x=0, y=0}}",
    "  local lt = box.left_top or {x=0, y=0}",
    "  local rb = box.right_bottom or {x=0, y=0}",
    "  local data = {",
    "    requested_tile = { x = math.floor(position.x), y = math.floor(position.y) },",
    "    name = entity_name,",
    "    direction = direction,",
    "    footprint = { left = lt.x, top = lt.y, right = rb.x, bottom = rb.y },",
    "    item_count = count,",
    "    surface_placeable = surface_placeable,",
    "  }",
    "  rcon.print(game.table_to_json(data))",
    "end)()",
  ].join("\n");
}

export function buildReachCommand(probe: BuildProbe): string {
  const name = luaString(probe.name);
  const x = luaNumber(probe.requestedTile.x);
  const y = luaNumber(probe.requestedTile.y);
  const direction = luaNumber(probe.direction);
  return [
    "(function()",
    "  local player = game.get_player(1) or (game.connected_players and game.connected_players[1])",
    "  if not player or not player.character then rcon.print('{\"reachable\":false}') return end",
    `  local entity_name = ${name}`,
    `  local position = {x = ${x}, y = ${y}}`,
    `  local direction = ${direction}`,
    "  local proto = prototypes.entity[entity_name]",
    "  if not proto then rcon.print('{\"reachable\":false}') return end",
    "  local ok = player.can_build_from_cursor{",
    "    name = entity_name,",
    "    position = position,",
    "    direction = direction,",
    "    force = player.force,",
    "  }",
    "  rcon.print(string.format('{\"reachable\":%s}', tostring(ok and ok ~= 0)))",
    "end)()",
  ].join("\n");
}

export function buildCommand(request: BuildRequest): string {
  const name = luaString(request.name);
  const x = luaNumber(request.x);
  const y = luaNumber(request.y);
  const direction = luaNumber(request.direction);
  return [
    "(function()",
    "  local player = game.get_player(1) or (game.connected_players and game.connected_players[1])",
    "  if not player or not player.character then",
    "    rcon.print('{\"ok\":false,\"error\":\"no_character\"}')",
    "    return",
    "  end",
    `  local entity_name = ${name}`,
    `  local requested_tile = {x = ${x}, y = ${y}}`,
    `  local build_direction = ${direction}`,
    "  local proto = prototypes.entity[entity_name]",
    "  if not proto then",
    "    rcon.print('{\"ok\":false,\"error\":\"invalid_target\"}')",
    "    return",
    "  end",
    "  local item_name = (proto.place_result and proto.place_result.name) or entity_name",
    "  if player.get_item_count(item_name) < 1 then",
    "    rcon.print('{\"ok\":false,\"error\":\"missing_item\"}')",
    "    return",
    "  end",
    "  local reach_ok = player.can_build_from_cursor{",
    "    name = entity_name,",
    "    position = requested_tile,",
    "    direction = build_direction,",
    "    force = player.force,",
    "  }",
    "  if not reach_ok then",
    "    rcon.print('{\"ok\":false,\"error\":\"out_of_reach\"}')",
    "    return",
    "  end",
    "  local temp = game.create_inventory(1)",
    "  local cleanup = function()",
    "    if temp and temp.valid then",
    "      local leftover = temp.get_contents()",
    "      for n, c in pairs(leftover) do",
    "        if c > 0 then player.insert{name=n, count=c} end",
    "      end",
    "      temp.destroy()",
    "    end",
    "  end",
    "  local cursor = player.cursor",
    "  local had_cursor = cursor and cursor.valid and cursor.valid_for_read",
    "  local ok, err = pcall(function()",
    "    if had_cursor then",
    "      temp.insert(cursor)",
    "      player.clear_cursor()",
    "    end",
    "    player.remove_item{name=item_name, count=1}",
    "    local inv = game.create_inventory(1)",
    "    inv.insert{name=item_name, count=1}",
    "    local stack = inv[1]",
    "    inv.destroy()",
    "    if player.cursor then player.clear_cursor() end",
    "    cursor.swap_stack(stack)",
    "    player.build_from_cursor{",
    "      name = entity_name,",
    "      position = requested_tile,",
    "      direction = build_direction,",
    "      force = player.force,",
    "    }",
    "  end)",
    "  if not ok then",
    "    cleanup()",
    "    rcon.print(string.format('{\"ok\":false,\"error\":\"build_failed\",\"detail\":\"%s\"}', tostring(err)))",
    "    return",
    "  end",
    "  local surface = player.surface",
    "  local ents = surface.find_entities_filtered{area={{requested_tile.x-0.5, requested_tile.y-0.5}, {requested_tile.x+0.5, requested_tile.y+0.5}}}",
    "  local placed = nil",
    "  for _, e in ipairs(ents) do",
    "    if e.name == entity_name and e.direction == build_direction then",
    "      placed = e",
    "      break",
    "    end",
    "  end",
    "  local cursor_restored = true",
    "  if had_cursor then",
    "    local saved = temp[1]",
    "    if saved and saved.valid_for_read then",
    "      if player.cursor then player.clear_cursor() end",
    "      cursor.swap_stack(saved)",
    "      cursor_restored = player.cursor and player.cursor.valid_for_read and player.cursor.name == saved.name and player.cursor.count == saved.count",
    "    end",
    "  end",
    "  if not cursor_restored then",
    "    cleanup()",
    "    rcon.print(string.format('{\"ok\":true,\"requested_tile\":{\"x\":%d,\"y\":%d},\"cursor_restored\":false,\"error\":\"cursor_restore_failed\"}', requested_tile.x, requested_tile.y))",
    "    return",
    "  end",
    "  if not placed then",
    "    cleanup()",
    "    rcon.print(string.format('{\"ok\":false,\"error\":\"verification_failed\",\"requested_tile\":{\"x\":%d,\"y\":%d}}', requested_tile.x, requested_tile.y))",
    "    return",
    "  end",
    "  local pos = placed.position",
    "  local box = placed.collision_box or {left_top = {x=0, y=0}, right_bottom = {x=0, y=0}}",
    "  local lt = box.left_top or {x=0, y=0}",
    "  local rb = box.right_bottom or {x=0, y=0}",
    "  cleanup()",
    "  local data = string.format('{\"ok\":true,\"requested_tile\":{\"x\":%d,\"y\":%d},\"actual_position\":{\"x\":%s,\"y\":%s},\"collision_box\":{\"left\":%s,\"top\":%s,\"right\":%s,\"bottom\":%s},\"direction\":%d,\"consumed\":1,\"cursor_restored\":true}',",
    "    requested_tile.x, requested_tile.y,",
    "    tostring(pos.x), tostring(pos.y),",
    "    tostring(lt.x), tostring(lt.y), tostring(rb.x), tostring(rb.y),",
    "    placed.direction or 0)",
    "  rcon.print(data)",
    "end)()",
  ].join("\n");
}

export function pulseMiningCommand(entity: EntityRef, itemName: string): string {
  const name = luaString(entity.name);
  const tx = luaNumber(entity.requestedTile.x);
  const ty = luaNumber(entity.requestedTile.y);
  const unit = entity.unitNumber === null
    ? "nil"
    : luaNumber(entity.unitNumber);
  const item = luaString(itemName);
  return [
    "(function()",
    "  local player = game.get_player(1) or (game.connected_players and game.connected_players[1])",
    "  if not player or not player.character then",
    "    rcon.print('{\"target_valid\":false,\"target_name\":\"\",\"target_type\":\"\",\"unit_number\":null,\"amount\":null,\"progress\":0,\"player_item_count\":0}')",
    "    return",
    "  end",
    `  local target = {x = ${tx}, y = ${ty}}`,
    `  local expected_name = ${name}`,
    `  local expected_unit = ${unit}`,
    `  local mining_item = ${item}`,
    "  local surface = player.surface",
    "  local function find_target()",
    "    local ents = surface.find_entities_filtered{area={{target.x-0.5, target.y-0.5}, {target.x+0.5, target.y+0.5}}}",
    "    for _, e in ipairs(ents) do",
    "      if e.type ~= 'character' then return e end",
    "    end",
    "    return surface.get_entity(target)",
    "  end",
    "  local entity = find_target()",
    "  if not entity then",
    "    rcon.print('{\"target_valid\":false,\"target_name\":\"\",\"target_type\":\"\",\"unit_number\":null,\"amount\":null,\"progress\":0,\"player_item_count\":0}')",
    "    return",
    "  end",
    "  if entity.name ~= expected_name then",
    "    rcon.print('{\"target_valid\":false,\"target_name\":\"\",\"target_type\":\"\",\"unit_number\":null,\"amount\":null,\"progress\":0,\"player_item_count\":0}')",
    "    return",
    "  end",
    "  if expected_unit and entity.unit_number ~= expected_unit then",
    "    rcon.print('{\"target_valid\":false,\"target_name\":\"\",\"target_type\":\"\",\"unit_number\":null,\"amount\":null,\"progress\":0,\"player_item_count\":0}')",
    "    return",
    "  end",
    "  player.update_selected_entity(entity.position)",
    "  player.mining_state = {mining = true, position = entity.position}",
    "  local progress = player.character_mining_progress or 0",
    "  local amount = entity.amount",
    "  local count = player.get_item_count(mining_item) or 0",
    "  local data = string.format(",
    "    '{\"target_valid\":true,\"target_name\":\"%s\",\"target_type\":\"%s\",\"unit_number\":%s,\"amount\":%s,\"progress\":%s,\"player_item_count\":%d}',",
    "    entity.name, entity.type,",
    "    entity.unit_number and tostring(entity.unit_number) or 'null',",
    "    tostring(amount or ''),",
    "    tostring(progress),",
    "    count)",
    "  rcon.print(data)",
    "end)()",
  ].join("\n");
}

export function stopMiningCommand(): string {
  return [
    "(function()",
    "  local player = game.get_player(1) or (game.connected_players and game.connected_players[1])",
    "  if not player then rcon.print('{}') return end",
    "  player.mining_state = {mining=false}",
    "  rcon.print('{\"mining\":false}')",
    "end)()",
  ].join("\n");
}

export function restoreSelectionCommand(): string {
  return [
    "(function()",
    "  local player = game.get_player(1) or (game.connected_players and game.connected_players[1])",
    "  if not player then rcon.print('{}') return end",
    "  rcon.print('{\"selected\":false}')",
    "end)()",
  ].join("\n");
}

export function rotateCommand(entity: EntityRef): string {
  const name = luaString(entity.name);
  const tx = luaNumber(entity.requestedTile.x);
  const ty = luaNumber(entity.requestedTile.y);
  const unit = entity.unitNumber === null
    ? "nil"
    : luaNumber(entity.unitNumber);
  return [
    "(function()",
    "  local player = game.get_player(1) or (game.connected_players and game.connected_players[1])",
    "  if not player or not player.character then",
    "    rcon.print('{\"ok\":false,\"before\":0,\"after\":0,\"error\":\"no_character\"}')",
    "    return",
    "  end",
    `  local target = {x = ${tx}, y = ${ty}}`,
    `  local expected_name = ${name}`,
    `  local expected_unit = ${unit}`,
    "  local surface = player.surface",
    "  local function find_entity()",
    "    local ents = surface.find_entities_filtered{area={{target.x-0.5, target.y-0.5}, {target.x+0.5, target.y+0.5}}}",
    "    for _, e in ipairs(ents) do",
    "      if e.type ~= 'character' then return e end",
    "    end",
    "    return surface.get_entity(target)",
    "  end",
    "  local e = find_entity()",
    "  if not e then",
    "    rcon.print('{\"ok\":false,\"before\":0,\"after\":0,\"error\":\"no_entity\"}')",
    "    return",
    "  end",
    "  if e.name ~= expected_name then",
    "    rcon.print('{\"ok\":false,\"before\":0,\"after\":0,\"error\":\"invalid_target\"}')",
    "    return",
    "  end",
    "  if expected_unit and e.unit_number ~= expected_unit then",
    "    rcon.print('{\"ok\":false,\"before\":0,\"after\":0,\"error\":\"invalid_target\"}')",
    "    return",
    "  end",
    "  if not player.can_reach_entity(e) then",
    "    rcon.print('{\"ok\":false,\"before\":e.direction or 0,\"after\":e.direction or 0,\"error\":\"out_of_reach\"}')",
    "    return",
    "  end",
    "  local before = e.direction or 0",
    "  e.rotate{by_player = player}",
    "  local after = e.direction or 0",
    "  rcon.print(string.format('{\"ok\":true,\"before\":%d,\"after\":%d}', before, after))",
    "end)()",
  ].join("\n");
}

export function setRecipeCommand(entity: EntityRef, recipe: string): string {
  const name = luaString(entity.name);
  const recipeName = luaString(recipe);
  const tx = luaNumber(entity.requestedTile.x);
  const ty = luaNumber(entity.requestedTile.y);
  const unit = entity.unitNumber === null
    ? "nil"
    : luaNumber(entity.unitNumber);
  return [
    "(function()",
    "  local player = game.get_player(1) or (game.connected_players and game.connected_players[1])",
    "  if not player or not player.character then",
    "    rcon.print('{\"ok\":false,\"requested\":\"' .. ${recipeName} .. '\",\"before\":null,\"after\":null,\"error\":\"no_character\"}')",
    "    return",
    "  end",
    `  local target = {x = ${tx}, y = ${ty}}`,
    `  local expected_name = ${name}`,
    `  local expected_unit = ${unit}`,
    "  local surface = player.surface",
    "  local function find_entity()",
    "    local ents = surface.find_entities_filtered{area={{target.x-0.5, target.y-0.5}, {target.x+0.5, target.y+0.5}}}",
    "    for _, e in ipairs(ents) do",
    "      if e.type ~= 'character' then return e end",
    "    end",
    "    return surface.get_entity(target)",
    "  end",
    "  local e = find_entity()",
    "  if not e then",
    "    rcon.print('{\"ok\":false,\"requested\":\"' .. ${recipeName} .. '\",\"before\":null,\"after\":null,\"error\":\"no_entity\"}')",
    "    return",
    "  end",
    "  if e.name ~= expected_name then",
    "    rcon.print('{\"ok\":false,\"requested\":\"' .. ${recipeName} .. '\",\"before\":null,\"after\":null,\"error\":\"invalid_target\"}')",
    "    return",
    "  end",
    "  if expected_unit and e.unit_number ~= expected_unit then",
    "    rcon.print('{\"ok\":false,\"requested\":\"' .. ${recipeName} .. '\",\"before\":null,\"after\":null,\"error\":\"invalid_target\"}')",
    "    return",
    "  end",
    "  if not player.can_reach_entity(e) then",
    "    rcon.print('{\"ok\":false,\"requested\":\"' .. ${recipeName} .. '\",\"before\":null,\"after\":null,\"error\":\"out_of_reach\"}')",
    "    return",
    "  end",
    "  if not e.set_recipe then",
    "    rcon.print('{\"ok\":false,\"requested\":\"' .. ${recipeName} .. '\",\"before\":null,\"after\":null,\"error\":\"invalid_recipe\"}')",
    "    return",
    "  end",
    "  local before = e.recipe and e.recipe.name or nil",
    "  local ok = e.set_recipe(${recipeName})",
    "  if not ok then",
    "    rcon.print('{\"ok\":false,\"requested\":\"' .. ${recipeName} .. '\",\"before\":\"' .. (before or '') .. '\",\"after\":null,\"error\":\"invalid_recipe\"}')",
    "    return",
    "  end",
    "  local after = e.recipe and e.recipe.name or nil",
    "  local data = string.format('{\"ok\":true,\"requested\":%s,\"before\":%s,\"after\":%s}', ${recipeName}, before and ('\"' .. before .. '\"') or 'null', after and ('\"' .. after .. '\"') or 'null')",
    "  rcon.print(data)",
    "end)()",
  ].join("\n");
}

export function buildVerifyCommand(request: BuildRequest): string {
  const name = luaString(request.name);
  const x = luaNumber(request.x);
  const y = luaNumber(request.y);
  const direction = luaNumber(request.direction);
  return [
    "(function()",
    "  local player = game.get_player(1) or (game.connected_players and game.connected_players[1])",
    "  if not player or not player.character then rcon.print('null') return end",
    `  local entity_name = ${name}`,
    `  local requested_tile = {x = ${x}, y = ${y}}`,
    `  local expected_direction = ${direction}`,
    "  local surface = player.surface",
    "  local ents = surface.find_entities_filtered{area={{requested_tile.x-0.5, requested_tile.y-0.5}, {requested_tile.x+0.5, requested_tile.y+0.5}}}",
    "  local placed = nil",
    "  for _, e in ipairs(ents) do",
    "    if e.name == entity_name then placed = e break end",
    "  end",
    "  if not placed then rcon.print('null') return end",
    "  if placed.direction ~= expected_direction then rcon.print('null') return end",
    "  local pos = placed.position",
    "  local box = placed.collision_box or {left_top = {x=0, y=0}, right_bottom = {x=0, y=0}}",
    "  local lt = box.left_top or {x=0, y=0}",
    "  local rb = box.right_bottom or {x=0, y=0}",
    "  local data = string.format('{\"ok\":true,\"requested_tile\":{\"x\":%d,\"y\":%d},\"actual_position\":{\"x\":%s,\"y\":%s},\"collision_box\":{\"left\":%s,\"top\":%s,\"right\":%s,\"bottom\":%s},\"direction\":%d,\"consumed\":1,\"cursor_restored\":true}',",
    "    requested_tile.x, requested_tile.y,",
    "    tostring(pos.x), tostring(pos.y),",
    "    tostring(lt.x), tostring(lt.y), tostring(rb.x), tostring(rb.y),",
    "    placed.direction or 0)",
    "  rcon.print(data)",
    "end)()",
  ].join("\n");
}

function parseJson<T>(response: string): T {
  const trimmed = response.trim();
  if (!trimmed) throw new Error("Empty RCON response");
  return JSON.parse(trimmed) as T;
}

export class FactorioActionAdapter implements ActionAdapter {
  constructor(
    private readonly execute: ExecuteRcon,
    private readonly walk: (target: Point) => Promise<WalkResult>,
  ) {}

  walkToPoint(target: Point): Promise<WalkResult> {
    return this.walk(target);
  }

  async probePlayer(): Promise<PlayerSnapshot> {
    const raw = parseJson<any>(await this.execute(playerProbeCommand()));
    if (!raw || raw.error) {
      return {
        connected: false,
        hasCharacter: false,
        surface: 0,
        controllerType: 0,
        position: { x: 0, y: 0 },
        reach: 0,
      };
    }
    const reach = Number(raw.reach_distance);
    const posRaw = raw.position || { x: 0, y: 0 };
    return {
      connected: raw.connected === true,
      hasCharacter: raw.has_character === true,
      surface: Number(raw.surface ?? 0),
      controllerType: Number(raw.controller_type ?? 0) || 0,
      position: { x: Number(posRaw.x || 0), y: Number(posRaw.y || 0) },
      reach: Number.isFinite(reach) ? reach : 0,
    };
  }

  async probeEntity(target: TilePoint): Promise<EntityRef | null> {
    const raw = await this.execute(entityProbeCommand(target));
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "null") return null;
    const parsed = parseJson<EntityRef>(trimmed);
    return parsed;
  }

  async probeBuild(input: {
    name: string;
    x: number;
    y: number;
    direction: number;
  }): Promise<BuildProbe> {
    return parseJson<BuildProbe>(await this.execute(buildProbeCommand(input)));
  }

  async isCharacterClear(point: Point): Promise<boolean> {
    const raw = parseJson<{ clear: boolean }>(
      await this.execute(characterClearCommand(point)),
    );
    return raw.clear === true;
  }

  async canReachEntity(entity: EntityRef): Promise<boolean> {
    const raw = parseJson<{ reachable: boolean }>(
      await this.execute(entityReachCommand(entity)),
    );
    return raw.reachable === true;
  }

  async canReachBuild(probe: BuildProbe): Promise<boolean> {
    const raw = parseJson<{ reachable: boolean }>(
      await this.execute(buildReachCommand(probe)),
    );
    return raw.reachable === true;
  }

  async build(request: BuildRequest): Promise<BuildOperationResult> {
    const base: BuildOperationResult = {
      ok: false,
      requestedTile: { x: request.x, y: request.y },
      actualPosition: null,
      collisionBox: null,
      direction: null,
      consumed: 0,
      cursorRestored: false,
    };
    let raw: any;
    try {
      raw = parseJson<any>(await this.execute(buildCommand(request)));
    } catch (err: any) {
      return { ...base, error: "verification_failed", detail: err?.message };
    }
    if (!raw || raw.ok !== true) {
      return {
        ...base,
        error: raw?.error || "verification_failed",
        detail: raw?.detail,
        cursorRestored: raw?.cursor_restored === true,
      };
    }
    return {
      ok: true,
      requestedTile: raw.requested_tile || base.requestedTile,
      actualPosition: raw.actual_position
        ? { x: Number(raw.actual_position.x), y: Number(raw.actual_position.y) }
        : null,
      collisionBox: raw.collision_box
        ? {
            left: Number(raw.collision_box.left),
            top: Number(raw.collision_box.top),
            right: Number(raw.collision_box.right),
            bottom: Number(raw.collision_box.bottom),
          }
        : null,
      direction: raw.direction ?? null,
      consumed: Number(raw.consumed ?? 0),
      cursorRestored: raw.cursor_restored === true,
    };
  }

  async verifyBuild(request: BuildRequest): Promise<BuildOperationResult> {
    const base: BuildOperationResult = {
      ok: false,
      requestedTile: { x: request.x, y: request.y },
      actualPosition: null,
      collisionBox: null,
      direction: null,
      consumed: 0,
      cursorRestored: false,
    };
    let raw: any;
    try {
      raw = parseJson<any>(await this.execute(buildVerifyCommand(request)));
    } catch (err: any) {
      return { ...base, error: "verification_failed", detail: err?.message };
    }
    if (!raw || raw.ok !== true) {
      return { ...base, error: "verification_failed" };
    }
    return {
      ok: true,
      requestedTile: raw.requested_tile || base.requestedTile,
      actualPosition: raw.actual_position
        ? { x: Number(raw.actual_position.x), y: Number(raw.actual_position.y) }
        : null,
      collisionBox: raw.collision_box
        ? {
            left: Number(raw.collision_box.left),
            top: Number(raw.collision_box.top),
            right: Number(raw.collision_box.right),
            bottom: Number(raw.collision_box.bottom),
          }
        : null,
      direction: raw.direction ?? null,
      consumed: Number(raw.consumed ?? 0),
      cursorRestored: raw.cursor_restored === true,
    };
  }

  async pulseMining(entity: EntityRef, itemName: string): Promise<MiningSnapshot> {
    let raw: any;
    try {
      raw = parseJson<any>(await this.execute(pulseMiningCommand(entity, itemName)));
    } catch (err: any) {
      throw new Error(`mining_pulse_failed: ${err?.message || err}`);
    }
    if (!raw || raw.target_valid !== true) {
      return {
        targetValid: false,
        targetName: raw?.target_name || "",
        targetType: raw?.target_type || "",
        unitNumber: raw?.unit_number ?? null,
        amount: raw?.amount ?? null,
        progress: 0,
        playerItemCount: 0,
      };
    }
    return {
      targetValid: true,
      targetName: String(raw.target_name || ""),
      targetType: String(raw.target_type || ""),
      unitNumber: raw.unit_number ?? null,
      amount: raw.amount === "" || raw.amount === null ? null : Number(raw.amount),
      progress: Number(raw.progress || 0),
      playerItemCount: Number(raw.player_item_count || 0),
    };
  }

  async stopMining(): Promise<void> {
    await this.execute(stopMiningCommand());
  }

  async restoreSelection(_entity: EntityRef | null): Promise<void> {
    await this.execute(restoreSelectionCommand());
  }

  async rotate(entity: EntityRef): Promise<RotateOperationResult> {
    const raw = parseJson<any>(await this.execute(rotateCommand(entity)));
    if (!raw || raw.ok !== true) {
      return {
        ok: false,
        before: Number(raw?.before ?? 0),
        after: Number(raw?.after ?? 0),
        error: raw?.error || "verification_failed",
      };
    }
    return {
      ok: true,
      before: Number(raw.before ?? 0),
      after: Number(raw.after ?? 0),
    };
  }

  async setRecipe(entity: EntityRef, recipe: string): Promise<RecipeOperationResult> {
    const raw = parseJson<any>(await this.execute(setRecipeCommand(entity, recipe)));
    if (!raw || raw.ok !== true) {
      return {
        ok: false,
        requested: recipe,
        before: raw?.before ?? null,
        after: raw?.after ?? null,
        error: raw?.error || "verification_failed",
      };
    }
    return {
      ok: true,
      requested: recipe,
      before: raw.before ?? null,
      after: raw.after ?? null,
    };
  }
}
