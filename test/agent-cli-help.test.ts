import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const command of [
  "act-build",
  "act-mine",
  "act-rotate",
  "act-set-recipe",
  "act-insert",
  "act-extract",
]) {
  test(`${command} help describes real action movement`, () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/agent-cli.ts", "help", command],
      { encoding: "utf8" },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.match(output, /physically walks/i);
    assert.doesNotMatch(output, /simulated walking/i);
  });
}
