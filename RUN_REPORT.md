# Factorio CLI Run Report

An AI agent attempted to beat Factorio (launch a rocket) using the CLI. This document captures the problems encountered and proposed solutions, ordered by impact on playability.

---

## Problem 1: Crafting Appears Instant But Is Async

### What happened
`act-craft` returns `{"ok": true}` immediately, but items take real game-time to appear in inventory. The agent crafted 200 automation science packs (5 seconds each = 1000 seconds total), got a success response, then spent ~20 minutes debugging why zero science packs were in inventory. The agent had no way to know crafting was queued, how long it would take, or how to observe the queue.

### Current response
```json
{"recipe": "automation-science-pack", "count": 200, "ok": true}
```

### Proposed fix
**Always include the crafting queue in `observe-player`** output:
```json
{"crafting_queue": [
  {"recipe": "iron-gear-wheel", "count": 45, "remaining_time": 2.3},
  {"recipe": "automation-science-pack", "count": 187, "remaining_time": 935.0}
]}
```

---

## Problem 2: No Entity Inspection

### What happened

## Real Character Actions — Live Regression Checklist

These checks document the live Factorio server regression for the `feature/real-character-actions` work. They were deferred per the user's instruction to skip live verification in this environment; please run them manually against a freshly-launched Factorio server before merging.

### Pre-flight
- [ ] `npm run agent -- server-start --save codex.zip` — server reaches a connected RCON state.
- [ ] `npm run agent -- server-status` — confirms `connected: true`.
- [ ] `npm run agent -- observe-player` — visible position, inventory, and character.

### Build and cursor restoration
- [ ] Start the graphical client, hold a non-target item on the cursor.
- [ ] `act-build` a stone furnace on a clear tile near the character.
- [ ] Verify the character physically walks to the tile before placing.
- [ ] Verify the held cursor item is restored after the action.
- [ ] `observe-entity` reports `requested_tile`, `actual_position`, `direction`, `collision_box`.

### Timed mining and resource single-cycle behavior
- [ ] `act-mine` on a placed entity; verify normal mining duration, no teleport, and clean stop when the entity is removed.
- [ ] `act-mine` on a resource patch; verify exactly one `amount` decrease per cycle, then the action returns successfully without leaving mining state on the character.

### Interactions and candidate failures
- [ ] Issue `act-rotate`, `act-set-recipe`, `act-insert`, and `act-extract` from a tile just outside reach; verify the character physically approaches before mutating state, and the observed state shows the change.
- [ ] With a partially-blocked target (one open candidate, one occluded by another entity), confirm `attempts` lists the blocked candidate first and the open second, with the action succeeding.
- [ ] With a fully blocked target, confirm the action returns `blocked` and `attempts` includes every candidate in order.

### FIFO serialization
- [ ] Concurrently fire `act-move` and `act-build`; verify movement completes before the build approach begins (no interleaved walking).

### Partial transfer conservation
- [ ] Request `act-insert` of more coal than the player holds; verify `returned_to_source` matches `removed_from_source - inserted_into_destination`.
- [ ] Request `act-extract --count all` from an entity with limited inventory; verify `returned_to_source` equals the rejected count.

### Cursor_restore_failed edge case
- [ ] Force a build while holding a stack-incompatible item; verify `cursor_restore_failed` is reported (not silent inventory loss).

### Record
Once all checks are completed, append the verification log to `RUN_REPORT.md` and remove this section's `[ ]` checkboxes.
