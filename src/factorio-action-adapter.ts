import type {
  ActionAdapter,
  BuildProbe,
  EntityRef,
  PlayerSnapshot,
  Point,
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
}
