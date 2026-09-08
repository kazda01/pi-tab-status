import { spawnSync } from "node:child_process";

const result = spawnSync(
  "pi",
  [
    "--offline",
    "--no-extensions",
    "-e",
    "./node_modules/@juanibiapina/pi-extension-settings",
    "-e",
    ".",
    "--list-models"
  ],
  { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 60_000 }
);

if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}
console.log("Pi loaded @kazda01/pi-tab-status successfully");
