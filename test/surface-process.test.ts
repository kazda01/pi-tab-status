import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { SurfaceManager } from "../src/surfaces.js";

const execFileAsync = promisify(execFile);

describe("surface process integration", () => {
  it("passes names as single argv values to fake multiplexer executables", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tab-surfaces-"));
    const log = join(root, "calls.jsonl");
    const script = join(root, "fake.mjs");
    await writeFile(script, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.CALL_LOG, JSON.stringify({ command, args }) + "\\n");
if (command === "zellij" && args[1] === "list-panes") {
  console.log(JSON.stringify([{ id: 2, title: "bash", tab_id: 7, tab_name: "Tab #1" }]));
}
`);
    await chmod(script, 0o755);
    for (const command of ["tmux", "herdr", "zellij"]) {
      await writeFile(join(root, command), await readFile(script));
      await chmod(join(root, command), 0o755);
    }

    let sessionName: string | undefined;
    const pi = {
      getSessionName: () => sessionName,
      setSessionName: (name: string) => { sessionName = name; },
      exec: async (command: string, args: string[], options?: { timeout?: number }) => {
        try {
          const result = await execFileAsync(command, args, {
            timeout: options?.timeout,
            env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CALL_LOG: log }
          });
          return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
        } catch (error) {
          const failed = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
          return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: failed.code ?? 1, killed: failed.killed ?? false };
        }
      }
    };
    const env = {
      TMUX: "1", TMUX_PANE: "%1",
      HERDR_ENV: "1", HERDR_PANE_ID: "pane", HERDR_TAB_ID: "tab",
      ZELLIJ: "1", ZELLIJ_PANE_ID: "2"
    };
    const manager = new SurfaceManager(pi as never, () => env);
    await manager.apply("Name; not a shell command");

    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { command: string; args: string[] });
    expect(calls.map((call) => basename(call.command))).toEqual(["tmux", "herdr", "herdr", "zellij", "zellij", "zellij"]);
    for (const call of calls.filter((entry) => entry.args.includes("rename-window") || entry.args.includes("rename-pane") || entry.args.includes("rename-tab") || entry.args.includes("rename"))) {
      expect(call.args.at(-1)).toBe("Name; not a shell command");
    }
  });
});
