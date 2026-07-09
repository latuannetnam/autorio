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

## Local Config

`.env` is intentionally ignored by git. This project was configured with:

```dotenv
PORT=3100
FACTORIO_BIN=E:\Games\Factorio\bin\x64\factorio.exe
FACTORIO_DIR=D:\latuan\Programming\autorio\factorio
FACTORIO_SAVES_DIR=D:\latuan\Programming\autorio\factorio\saves
FACTORIO_SERVER_SETTINGS=D:\latuan\Programming\autorio\factorio\config\server-settings.json
FACTORIO_SERVER_ADMINLIST=D:\latuan\Programming\autorio\factorio\config\server-adminlist.json
FACTORIO_CONFIG=D:\latuan\Programming\autorio\factorio\config\config.ini
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
& "E:\Games\Factorio\bin\x64\factorio.exe" --config "D:\latuan\Programming\autorio\factorio\config\config.ini" --create "D:\latuan\Programming\autorio\factorio\saves\codex.zip"
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

Build an entity:

```powershell
npm run agent -- act-build -- --entity "burner-mining-drill,-60,-49,4"
```

Insert fuel/items:

```powershell
npm run agent -- act-insert -- --entity "-60,-49" --item coal --count 1
```

Extract from a container:

```powershell
npm run agent -- act-extract -- --entity "-5,-6" --item firearm-magazine --count all
```

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