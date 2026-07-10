# Real Character Actions Design

## Goal

Replace teleporting and simulated target actions with visible, player-like Factorio behavior. Targeted actions should automatically walk the connected character into range, obey reach and inventory rules, perform the closest legitimate Factorio player operation, verify the outcome, and return useful per-target diagnostics.

This design covers `act-build`, `act-mine`, `act-rotate`, `act-set-recipe`, `act-insert`, and `act-extract`. `act-move` remains the real-walking primitive developed in the preceding movement phase, but it joins the shared action lock because it mutates the same walking state. Crafting is unchanged because it already uses the player crafting queue and does not require target movement.

## Current Behavior

- Target action handlers in `src/server.ts` probe distance, wait for a simulated walking delay, and then execute a Lua command.
- Build, mine, rotate, set-recipe, insert, and extract Lua commands contain helpers that teleport the player near their target.
- Build removes an item and calls `surface.create_entity` rather than building from the player's cursor.
- Mine calls `player.mine_entity`, which completes immediately rather than using normal mining duration.
- Several handlers duplicate probe, delay, RCON parsing, and per-target result logic.
- Concurrent character-mutating requests are not coordinated and can overwrite walking, cursor, selection, or mining state.

## Decisions

### Scope And Realism

This phase implements full practical realism for all targeted actions:

- Every target action automatically walks the character into range.
- Approach planning tries multiple clear standing positions around the target.
- Building uses the cursor and `LuaPlayer.build_from_cursor`.
- Mining uses `LuaControl.mining_state` and takes normal in-game time.
- Rotate, set-recipe, insert, and extract use the closest legitimate Lua APIs because Factorio does not expose an RCON equivalent for individual GUI clicks.
- All actions enforce real reach, player inventory, target validity, and post-action verification.
- Batch requests continue after individual failures and return one result per accepted target.

This phase does not add global pathfinding or a persistent Factorio mod. Candidate-based local approach planning is the boundary. If it proves insufficient, a later phase can move orchestration into a tick-driven mod and use Factorio's asynchronous pathfinder.

### Architecture

HTTP parsing and response envelopes remain in `src/server.ts`. A focused action controller owns character action orchestration so the route file does not accumulate six more independent state machines.

The controller has these responsibilities:

1. Serialize character-mutating requests, including public `act-move`, through a FIFO action lock.
2. Validate and normalize each target.
3. Probe the target entity or proposed build location.
4. Generate and rank candidate standing positions.
5. Walk to candidates and confirm actual Factorio reach.
6. Execute the action through a small Factorio adapter operation.
7. Poll time-based actions such as mining.
8. Verify world and inventory changes.
9. Restore temporary state and release the action lock in all exit paths.
10. Compose stable per-target diagnostics.

The controller depends on narrow adapter operations for RCON probes and state changes. Lua snippets remain short and single-purpose. Node owns waiting, polling, timeout decisions, candidate fallback, batching, and error normalization.

## Shared Action Flow

Each target follows this lifecycle:

```text
validate
  -> preflight target and inventory
  -> generate standing candidates
  -> walk to candidate
  -> confirm reach
  -> perform action
  -> poll when necessary
  -> verify result
  -> restore transient state
  -> return result
```

If a candidate is blocked or does not provide actual reach, the controller records that attempt and tries the next candidate. Exhausting all candidates returns a gameplay failure without failing the entire HTTP request.

Character-mutating HTTP requests acquire one FIFO lock. This includes `act-move` as well as every target action in this design. Batches hold the lock while their targets execute sequentially, preventing another request from changing shared character state between targets. Individual target failures do not stop the remaining targets. Crafting does not acquire this lock because it does not mutate walking, cursor, selection, or mining state.

## Movement And Approach Planning

The movement layer gains an internal world-position operation. Public `act-move` retains tile-coordinate semantics and continues converting requested tiles to tile centers. Internal action movement accepts exact world coordinates so candidate standing positions are not shifted by another half tile.

Public action coordinates remain the existing tile anchors. Build passes the requested `{x,y}` placement point unchanged to Factorio so `build_from_cursor` applies the same placement-grid snapping as the current `create_entity` path. Entity-target actions continue resolving the entity that occupies the requested tile. Build results contain both `requested_tile:{x,y}` and the authoritative `actual_position:{x,y}` returned by the created entity; diagnostics also include its actual collision box. Candidate footprints are calculated from the prototype collision box after applying the requested direction, including rotated and multi-tile entities.

For an existing entity, candidates are derived around its collision box. For a proposed build, candidates are derived around the requested entity footprint. The initial candidate set contains up to eight cardinal and diagonal positions around the expanded footprint.

Candidates must:

- Be outside the target or proposed placement footprint.
- Be non-colliding for the character.
- Be within the estimated interaction distance.
- Belong to the same surface as the connected character.
- Be sorted by distance from the character's current position.

Candidate geometry is an estimate. After walking, Factorio remains authoritative: entity interactions use `player.can_reach_entity`, and building uses cursor placement checks. A successful walk that still cannot reach the target records `out_of_reach` for that candidate and proceeds to the next one.

This is bounded local fallback, not obstacle pathfinding. The controller does not synthesize arbitrary waypoint routes. A blocked result includes every attempted candidate so Codex can observe the area and decide what to change.

## Action Mechanics

### Build

Build preflight verifies the item exists in the player's inventory, the prototype can place an entity, the requested direction is valid, and the proposed position is not already invalid for terrain or collision reasons.

The build operation is transactional. After movement and reach preparation, cursor preservation, requested-item setup, `can_build_from_cursor`, `build_from_cursor`, immediate placement verification, cursor restoration, and temporary-inventory destruction execute inside one RCON Lua command. Node performs an additional read-only verification afterward. Keeping the cursor transaction in one command prevents client input or an RCON failure between commands from exposing temporary cursor state.

1. Preserve the complete existing cursor stack in temporary script-owned storage.
2. Move one requested item from the player's inventory into the cursor.
3. Confirm the target can be built from the cursor at the character's actual position.
4. Call `player.build_from_cursor` with the requested position and direction.
5. Verify that the expected entity exists at the requested location and direction and that one requested item was consumed.
6. Return leftover requested cursor contents to the player inventory.
7. Restore the original cursor stack.
8. Destroy temporary storage.

Cursor restoration runs in cleanup even when placement fails. If restoration cannot fit the saved stack back into the cursor or player inventory, the result reports `cursor_restore_failed` with the preserved stack details; items must not be silently deleted.

Build no longer calls `surface.create_entity`. Normal build events and Factorio inventory consumption come from `build_from_cursor`.

### Mine

Mine selects one specifically minable entity and excludes all character entities from target resolution. It approaches the entity, confirms reach, sets the player's selected entity, and repeatedly applies `mining_state` while Node polls.

Completion depends on target type. For non-resource entities, one mining action completes when the original entity becomes invalid or is replaced consistently with mining. For resource entities, one mining action completes when the original `amount` decreases from its starting value or the resource entity becomes invalid. The controller stops after that single resource-mining cycle rather than depleting the entire tile. Polling reads Factorio 2.0.73's `character_mining_progress`, target validity, resource amount, and inventory deltas. Normal mining time, tools, mining categories, speed modifiers, and inventory behavior determine duration.

Walking and mining states are stopped in cleanup. The prior selected entity is restored when still valid. Mine no longer calls immediate `player.mine_entity`.

### Rotate

Rotate approaches the entity, confirms reach, records the original direction, calls the entity rotation API, and verifies that direction changed to the returned value. A valid call that produces no direction change returns `verification_failed` rather than success.

### Set Recipe

Set-recipe approaches the entity, confirms reach, validates that the recipe exists and is compatible with the target, applies the recipe, and reads the selected recipe back. Invalid or unavailable recipes return `invalid_recipe`; a mismatched readback returns `verification_failed`.

### Insert

Insert approaches the entity, confirms reach, verifies that the player owns the requested item count, and uses `LuaControl.insert` on the target. This intentionally preserves the current automatic best-inventory selection for entities with input, fuel, module, or other inventories. Verification compares the target's total count for the requested item before and after insertion. The result reports requested, removed from player, inserted into target, and returned-to-player counts. Partial insertion is a successful partial result, not silent full success.

### Extract

Extract approaches the entity, confirms reach, reads the target's total count for the requested item, and uses `LuaControl.remove_item` on the target. This intentionally preserves the current automatic inventory selection rather than adding a new inventory selector to the API. It transfers only what can fit in the player's inventory, and `count=all` remains supported. The result reports available, requested, removed from target, inserted into player, and returned-to-target counts. No item may be lost when the player inventory fills during transfer.

## API Behavior

Existing endpoint and CLI input formats remain compatible. Build, mine, rotate, and set-recipe retain `{ ok:true, data:{ results }, truncated }`; insert and extract retain `{ ok:true, data }`. Richer action details are added to each existing result object without moving it to a different envelope.

Each action result includes:

- `ok`, action name, and requested target.
- Final player position.
- Chosen approach position when one succeeds.
- An ordered list of attempted candidates and their movement/reach outcomes.
- Movement and action elapsed times.
- Action-specific before and after values.
- `verified` and verification details.
- A stable `error` and optional human-readable `detail` on failure.

Invalid request syntax returns HTTP `400`. Missing RCON configuration or connection returns HTTP `409`. A syntactically valid request whose gameplay action fails returns HTTP `200` with `ok:false` on the affected target result. Unexpected server failures may return HTTP `500` after cleanup is attempted.

Stable gameplay errors include:

- `invalid_target`
- `no_character`
- `no_entity`
- `not_minable`
- `missing_item`
- `collision`
- `invalid_position`
- `blocked`
- `out_of_reach`
- `inventory_full`
- `invalid_recipe`
- `timeout`
- `interrupted`
- `verification_failed`
- `cursor_restore_failed`

An action is interrupted when the player disconnects, loses or changes character/controller, changes surface, the target disappears unexpectedly, or required transient state is externally replaced. Cleanup still runs and the lock is released.

## Reliability And Cleanup

All action execution uses structured cleanup boundaries:

- Stop walking on success, failure, timeout, and exception.
- Stop mining on success, failure, timeout, and exception.
- Restore selection after mining when possible.
- Restore cursor state and destroy temporary inventory after building.
- Return partially transferred items to their source when the destination accepts fewer than expected.
- Release the action lock in a final block.

Timeouts are action-specific. Movement uses the existing distance-based timeout and blocked detection. Mining uses prototype mining time plus a conservative multiplier and hard cap, while progress polling distinguishes slow progress from a stall. Other interactions have short command and verification timeouts.

## Testing

The implementation adds an explicit TypeScript test harness using Node's built-in `node:test` runner through the existing `tsx` development dependency. `package.json` gains `npm test`, tests live under `test/**/*.test.ts`, and production compilation remains limited to `src` in `tsconfig.json`. Tests import source modules through `tsx`; they are not emitted into `dist`.

### Pure Tests

- Candidate generation around one-tile and multi-tile footprints.
- Candidate filtering and distance sorting.
- Tile versus world coordinate handling.
- Stable error normalization.
- Per-target and batch result composition.

### Controller Tests With A Fake Adapter

- Successful first-candidate approach.
- Blocked first candidate followed by successful fallback.
- Exhausted candidate diagnostics.
- Reach failure after successful walking.
- Cursor preservation and restoration on build success and failure.
- Missing build item and placement collision.
- Normal mining completion, timeout, interruption, and cleanup.
- Single-cycle resource mining based on an `amount` decrease while the entity remains valid.
- Partial insert and extract without item loss.
- Recipe and rotation verification failures.
- Batch continuation after a failed target.
- FIFO serialization of concurrent mutating requests.
- Serialization between public `act-move` and target actions.
- Lock release and state cleanup after adapter exceptions.

### Live Factorio Verification

- Watch the character visibly walk before every target action.
- Build from player inventory with normal cursor consumption and build events.
- Confirm an existing cursor stack is restored after successful and failed builds.
- Observe mining take normal in-game time and stop cleanly.
- Exercise a blocked approach that succeeds through an alternative candidate.
- Exercise a fully blocked target and inspect returned candidate diagnostics.
- Verify rotate, recipe, insert, and extract only succeed in reach.
- Verify partial and full-inventory transfers do not lose items.
- Run existing CLI examples to confirm input compatibility.

## Delivery Stages

1. TypeScript test harness, shared action controller, FIFO lock including `act-move`, exact-position walking, candidate planning, adapter boundary, and diagnostics.
2. Player-style building with transactional cursor handling.
3. Timed player-style mining.
4. Reach-aware rotate, set-recipe, insert, and extract.
5. CLI/help updates and complete live regression checks.

Each stage must compile and pass its focused tests before the next stage begins.

## Acceptance Criteria

- Build, mine, rotate, set-recipe, insert, and extract physically approach their targets.
- No targeted action path teleports the player or waits for simulated travel time.
- Build does not call direct entity creation and uses player inventory through the cursor.
- Mining takes normal Factorio time and does not call immediate mining helpers.
- Candidate fallback handles locally blocked approach positions and reports all attempts on failure.
- Cursor, walking, mining, selection, and transfer state are cleaned up reliably.
- Concurrent character-mutating requests cannot interfere with each other.
- Public `act-move` cannot run concurrently with a target action.
- Resource mining stops after one completed mining cycle even when the resource entity remains valid.
- Batch requests continue after failures and return one result per accepted target.
- Existing API and CLI request formats remain compatible.
- Automated controller tests and live connected-client verification pass.

## Out Of Scope

- Global pathfinding or arbitrary waypoint generation.
- A persistent Factorio mod or scenario controller.
- Simulating individual inventory GUI clicks where Factorio exposes no equivalent runtime input API.
- Changes to crafting behavior.
- Combat, driving, repairing, blueprint placement, or deconstruction planning.

## References

- Factorio 2.0.73 runtime `LuaControl` documentation for walking, mining, selection, cursor, and inventory state: https://lua-api.factorio.com/2.0.73/classes/LuaControl.html
- Factorio 2.0.73 runtime `LuaPlayer` documentation for cursor building: https://lua-api.factorio.com/2.0.73/classes/LuaPlayer.html
- Factorio 2.0.73 runtime `LuaGameScript` and `LuaItemStack` documentation for temporary inventory and atomic cursor preservation: https://lua-api.factorio.com/2.0.73/classes/LuaGameScript.html and https://lua-api.factorio.com/2.0.73/classes/LuaItemStack.html
- Preceding movement design: `docs/superpowers/specs/2026-07-09-real-character-movement-design.md`
