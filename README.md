# autorio

`autorio` is a local Factorio automation harness inspired by
<https://ryanmadden.net/claude-plays-factorio/>. It runs a Node/TypeScript API
server that can start a local Factorio multiplayer server, connect to it over
RCON, and expose observe/action commands for Codex or another agent. It also
serves a small web UI for status, logs, RCON, and world inspection.

## How The Pieces Fit

- Factorio runs as a local headless multiplayer server.
- `src/server.ts` exposes `http://127.0.0.1:3100` for server control, RCON, and agent actions.
- `src/agent-cli.ts` is the CLI Codex uses to observe the world and act in it.
- The human Factorio client connects to the same local server to watch the agent.

### Agent Action Architecture

Every target action (`act-move`, `act-build`, `act-mine`, `act-rotate`, `act-set-recipe`, `act-insert`, `act-extract`) physically walks the player character into reach before touching game state — there is no teleporting, no `surface.create_entity`, no `player.mine_entity`, and no simulated travel delay. The architecture is split into three layers:

- `src/agent-actions.ts` — shared types (`ActionAdapter`, `Point`, `Box`, `WalkResult`, etc.), an `AsyncFifoLock` that serializes public `act-move` together with every target action, and `AgentActionController` which owns candidate generation (`generateApproachCandidates`), per-target batches, and approach fallback.
- `src/factorio-action-adapter.ts` — all Factorio 2.0.73 probe and mutation Lua. Each command is a pure builder (`playerProbeCommand`, `entityProbeCommand`, `buildCommand`, `pulseMiningCommand`, `rotateCommand`, `setRecipeCommand`, `insertCommand`, `extractCommand`, etc.) wrapped by `FactorioActionAdapter` which injects RCON and the movement function.
- `src/server.ts` — HTTP routing only. Each `act-*` route hands its target list to the controller and maps the camelCase result back to the existing snake_case response envelope.

Action batches hold the FIFO lock, walk each candidate from nearest-first sorted list, retry the next candidate when the character is blocked, and continue past per-target failures. `act-build` uses an atomic cursor transaction (save current cursor → place via `cursor.swap_stack` + `player.build_from_cursor` → restore cursor → destroy temp inventory) and only destroys the temp inventory if it is empty; if cursor restoration fails the saved stack is left in temp and `cursor_restore_failed` is returned. `act-mine` enters the player's timed mining state via `player.update_selected_entity` + `player.mining_state = {mining=true, position=...}`, polls `player.character_mining_progress`, and stops after one `amount` decrease for resources. `act-insert` / `act-extract` use `LuaControl.insert` and `LuaControl.remove_item` automatically (no explicit inventory indexes) and return lossless counts (`removed_from_source = inserted_into_destination + returned_to_source`).

In the current local setup:

- Factorio executable: `E:\Games\Factorio\bin\x64\factorio.exe`
- API/web UI: `http://127.0.0.1:3100`
- Factorio multiplayer address: `127.0.0.1:34197`
- RCON: `127.0.0.1:27015`
- Save file: `factorio/saves/codex.zip`

## Install

```powershell
npm install
npm run build
```

`npm run dev` exists, but on this Windows sandbox `tsx`/esbuild can hit `spawn EPERM`. Use the compiled server with `npm run start` for the reliable runtime path.

## Tests

```powershell
npm test
```

Test files live in `test/` and run under `tsx --test`. They cover:

- FIFO lock ordering and shared work (`AsyncFifoLock`)
- Approach candidate geometry and sorting (`generateApproachCandidates`, `rotateBox`)
- `AgentActionController` move/build/mine batching against a fake `ActionAdapter`
- `FactorioActionAdapter` Lua command builders and conservation (`insertCommand` / `extractCommand`)
- CLI help text for every target action uses the new "physically walks" wording and no longer mentions "simulated walking"

## Agent Action Diagnostics

All target actions share the same response contract (`{ok:true, data:{ results }, truncated}` for batched actions, `{ok:true, data}` for single-result `act-insert`/`act-extract`) plus the existing HTTP 400/409 envelopes. Per-target results may carry:

- `error`: `"blocked"` (no candidate succeeded), `"out_of_reach"` (approach succeeded but the entity drifted out of reach before the mutation), `"no_entity"` / `"not_minable"` / `"missing_item"` / `"invalid_recipe"` / `"verification_failed"` / `"cursor_restore_failed"`.
- `attempts` (where applicable): the ordered list of candidates the controller tried, with `movement.ok`, `reachable`, and `error` per attempt. Inspect this to debug a blocked first candidate versus a fully-blocked target.
- `cycles`, `final.amount`, etc. (`act-mine` only): how many pulses ran and the resource amount observed at completion.

Always verify mutations with `observe-entity` or `observe-player` before proceeding — actions can take real game time and the controller continues past per-target failures.

## Local Config

`.env` is intentionally ignored by git. This project was configured with:

```dotenv
PORT=3100
FACTORIO_BIN=\Games\Factorio\bin\x64\factorio.exe
FACTORIO_DIR=\autorio\factorio
FACTORIO_SAVES_DIR=\autorio\factorio\saves
FACTORIO_SERVER_SETTINGS=\autorio\factorio\config\server-settings.json
FACTORIO_SERVER_ADMINLIST=\autorio\factorio\config\server-adminlist.json
FACTORIO_CONFIG=\autorio\factorio\config\config.ini
RCON_HOST=127.0.0.1
RCON_PORT=27015
RCON_PASSWORD=codex-rcon-local
FACTORIO_API_BASE=http://127.0.0.1:3100
```

The separate `FACTORIO_CONFIG` is important on Windows. It points Factorio at repo-local write data under `factorio/server-data`, which lets the headless server run beside a graphical Factorio client without fighting over the normal `AppData\Roaming\Factorio` lock file.

## Runtime Files

These are local runtime files and are ignored by git:

- `factorio/config/config.ini`: server-only Factorio config.
- `factorio/config/server-settings.json`: local multiplayer server settings.
- `factorio/config/server-adminlist.json`: server admin list.
- `factorio/saves/codex.zip`: current game save.
- `factorio/server-data/`: Factorio write-data directory.
- `factorio.pid`: current Factorio process id.

If `codex.zip` does not exist, create it with:

```powershell
& "E:\Games\Factorio\bin\x64\factorio.exe" --config "autorio\factorio\config\config.ini" --create "autorio\factorio\saves\codex.zip"
```

## Start The Server

Start the API server:

```powershell
npm run start
```

Then start Factorio through the API:

```powershell
npm run agent -- server-start -- --save codex.zip
```

The second `--` is important when passing CLI flags through `npm run`.

Check status:

```powershell
npm run agent -- server-status
npm run agent -- server-saves
```

RCON may take a few seconds after `server-start` while Factorio loads the map. `server-status` should eventually show `"connected":true` under `rcon`.

## Watch Codex Play

Open Factorio, then connect:

```text
Multiplayer -> Connect to address -> 127.0.0.1:34197
```

The dedicated server has no `game.players[1]` until a real client joins. After the client connects, Codex can observe and act through the player-controlled commands.

## Useful Agent Commands

Observe player:

```powershell
npm run agent -- observe-player -- --limit-inventory 80 --limit-equipment 10
```

Observe nearby world:

```powershell
npm run agent -- observe-world -- --window-x 0 --window-y 0 --radius 20 --include "tiles,entities"
```

Scan resources:

```powershell
npm run agent -- observe-resources -- --window-x 0 --window-y 0 --radius 180
```

Build an entity (character walks to the tile, places via the cursor, and restores the original cursor stack):

```powershell
npm run agent -- act-build -- --entity "burner-mining-drill,-60,-49,4"
```

Mine an entity or a single resource cycle (uses `mining_state`, stops after one `amount` decrease for resources):

```powershell
npm run agent -- act-mine -- --target "-60,-49"
```

Rotate (or configure a recipe) on a target the character can already reach:

```powershell
npm run agent -- act-rotate -- --target "-58,-49"
npm run agent -- act-set-recipe -- --target "-58,-49,iron-gear-wheel"
```

Insert fuel/items (lossless: any rejected count is returned to the source):

```powershell
npm run agent -- act-insert -- --entity "-60,-49" --item coal --count 1
```

Extract from a container (`--count all` removes everything currently in inventory):

```powershell
npm run agent -- act-extract -- --entity "-5,-6" --item firearm-magazine --count all
```

All `act-*` commands share the FIFO lock with `act-move`, so concurrent calls serialize naturally — submitting several in parallel will not race the character.

## First-Run Play Notes

On the current `codex.zip` map, the live scouting found:

- Spawn/crash site: around `(0,0)`.
- Crash-site spaceship: around `(-5,-6)`, initially holding extra magazines.
- Wreck containers: around `(-20,-4)` and `(-16,-2)`, initially holding a few iron plates.
- Iron patch: centered around `(-60,-49)`.
- Coal patch: centered around `(42,-100)`.
- Copper patch: around `(39,49)`, broad patch.
- Stone patch: northwest around `(-73,-88)`.

The first working bootstrap pattern is:

1. Loot crash-site containers.
2. Place the burner mining drill on iron at `(-60,-49)` facing east (`direction=4`).
3. Place the stone furnace directly on the drill output tile at `(-58,-49)`.
4. Fuel the drill and furnace with coal.

The furnace at `(-57,-49)` is one tile too far east for that drill placement. If the drill reports `waiting_for_space_in_destination`, inspect the output tile and move the receiving entity closer.

## Stop The Server

```powershell
npm run agent -- server-stop
```

This asks Factorio to stop through the API. The API server itself remains running until its terminal is stopped.