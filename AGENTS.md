# AGENTS.md

## Purpose

This file is for Codex. Keep human setup instructions in `README.md`; use this file as the short operational guide for working in this repo and playing the connected Factorio save.

## Project Shape

- `src/server.ts`: API server, Factorio process manager, RCON bridge, agent endpoints.
- `src/agent-cli.ts`: CLI wrapper for the API.
- `public/`: small web UI for server status/logs/RCON/world view.
- `factorio/`: ignored local runtime data, config, saves, and server write-data.
- `dist/`: compiled output.
- `RUN_REPORT.md`: known AI-playthrough gaps and improvement ideas.

For full setup, `.env`, server config, and connection instructions, read `README.md`.

## Build And Run

- Build after TypeScript changes: `npm run build`.
- Prefer compiled server on Windows: `npm run start`.
- `npm run dev` may fail with `spawn EPERM` in this sandbox.
- CLI shape: `npm run agent -- <command>`.
- When a CLI command has flags, pass an extra separator: `npm run agent -- <command> -- <flags>`.

PowerShell quoting rules matter:

```powershell
npm run agent -- server-start -- --save codex.zip
npm run agent -- observe-player -- --limit-inventory 80 --limit-equipment 10
npm run agent -- act-build -- --entity "burner-mining-drill,-60,-49,4"
npm run agent -- observe-world -- --window-x 0 --window-y 0 --radius 20 --include "tiles,entities"
```

Always quote comma-separated coordinates and entity specs: `"-60,-49"`, `"burner-mining-drill,-60,-49,4"`.

## Session Startup

1. Check server/RCON:

```powershell
npm run agent -- server-status
```

2. If no server is running, follow `README.md` to start API and Factorio.
3. Check player and resources:

```powershell
npm run agent -- observe-player -- --limit-inventory 80 --limit-equipment 10
npm run agent -- observe-resources -- --window-x 0 --window-y 0 --radius 180
```

If `observe-player` returns `{ "error": "No player" }`, the human Factorio client has not joined yet. Ask them to connect to `127.0.0.1:34197`.

## Playing Rules

- Treat every action as untrusted until verified with `observe-player`, `observe-entity`, or `observe-world`.
- Long-distance actions simulate walking and can take 10+ seconds.
- Prefer small-radius observations; large `observe-world` output is noisy.
- Use `observe-resources` for patch discovery and `observe-world --include "tiles,entities"` for placement debugging.
- Do not target the player tile with `act-mine`; it mines the first entity at that tile and can target the character.
- `observe-entity-prototype` currently has a Factorio 2.0 API mismatch. Use observed entity boxes/world inspection or known vanilla sizes until fixed.

## Current Save Landmarks

Observed on local `codex.zip`:

- Spawn/crash site: around `(0,0)`.
- Crash-site spaceship: around `(-5,-6)`.
- Wreck containers: around `(-20,-4)` and `(-16,-2)`.
- Iron patch: centered around `(-60,-49)`.
- Coal patch: centered around `(42,-100)`.
- Copper patch: broad patch around `(39,49)`.
- Stone patch: northwest around `(-73,-88)`.

Useful starter inspection:

```powershell
npm run agent -- observe-entity -- --target "-5,-6" --target "-20,-4" --target "-16,-2"
```

## Early Bootstrap

Goal: stable iron plates.

1. Loot useful crash-site containers.
2. Place burner mining drill on iron at `(-60,-49)`, facing east (`direction=4`):

```powershell
npm run agent -- act-build -- --entity "burner-mining-drill,-60,-49,4"
```

3. Place stone furnace on the drill output tile at `(-58,-49)`, not `(-57,-49)`:

```powershell
npm run agent -- act-build -- --entity "stone-furnace,-58,-49,0"
```

4. Fuel drill and furnace:

```powershell
npm run agent -- act-insert -- --entity "-60,-49" --item coal --count 1
npm run agent -- act-insert -- --entity "-58,-49" --item coal --count 1
```

5. Verify:

```powershell
npm run agent -- observe-entity -- --target "-60,-49" --target "-58,-49"
```

Healthy signs:

- Drill is `working` or producing.
- Furnace recipe is `iron-plate`, has fuel, and outputs plates after a delay.

If the drill reports `waiting_for_space_in_destination`, inspect around it:

```powershell
npm run agent -- observe-world -- --window-x -60 --window-y -49 --radius 4 --include "tiles,entities"
```

For the tested drill at `(-60,-49)` facing east, the furnace at `(-57,-49)` was too far away. `(-58,-49)` aligned with the output footprint.

## Code Change Notes

- Keep changes scoped; avoid unrelated refactors.
- Do not commit ignored runtime files (`.env`, `factorio/`, `factorio.pid`).
- Run `npm run build` after TypeScript edits.
- If changing CLI usage or setup behavior, update `README.md`; if changing agent behavior/pitfalls, update this file.