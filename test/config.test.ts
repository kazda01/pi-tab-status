import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSettingMock } = vi.hoisted(() => ({ getSettingMock: vi.fn() }));
vi.mock("@juanibiapina/pi-extension-settings", () => ({ getSetting: getSettingMock }));

import {
  DEFAULT_CONFIG,
  globalConfigPath,
  loadConfig,
  parseModelKey,
  saveGlobalConfig,
  validateConfig
} from "../src/config.js";

beforeEach(() => {
  getSettingMock.mockReset();
  getSettingMock.mockReturnValue(undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("configuration", () => {
  it("resolves XDG paths and model keys", () => {
    expect(globalConfigPath({ XDG_CONFIG_HOME: "/tmp/config" })).toBe("/tmp/config/pi-tab-status/config.json");
    expect(globalConfigPath({})).toContain("/.config/pi-tab-status/config.json");
    expect(globalConfigPath({ XDG_CONFIG_HOME: "~" })).toContain("/pi-tab-status/config.json");
    expect(globalConfigPath({ XDG_CONFIG_HOME: "~/custom" })).toContain("/custom/pi-tab-status/config.json");
    expect(globalConfigPath({ XDG_CONFIG_HOME: "relative" })).toContain("/.config/pi-tab-status/config.json");
    expect(parseModelKey("openrouter/vendor/model:free")).toEqual({ provider: "openrouter", modelId: "vendor/model:free" });
    expect(parseModelKey("invalid")).toBeUndefined();
    expect(parseModelKey("/invalid")).toBeUndefined();
  });

  it("uses defaults when files are absent and ignores legacy model env vars", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tab-status-"));
    const result = await loadConfig(root, true, {
      XDG_CONFIG_HOME: join(root, "xdg"),
      PI_TAB_DESCRIPTION_PROVIDER: "ignored",
      PI_TAB_DESCRIPTION_MODEL: "ignored"
    });
    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect(result.config.description.model).toBe("");
    expect(result.warnings).toEqual([]);
  });

  it("deep merges global and trusted project settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tab-status-"));
    const xdg = join(root, "xdg");
    await mkdir(join(xdg, "pi-tab-status"), { recursive: true });
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(xdg, "pi-tab-status", "config.json"), JSON.stringify({ loader: { preset: "dots" }, description: { wordCount: 4 } }));
    await writeFile(join(root, ".pi", "pi-tab-status.json"), JSON.stringify({ loader: { intervalMs: 120 }, icons: { done: "!" } }));
    const result = await loadConfig(root, true, { XDG_CONFIG_HOME: xdg });
    expect(result.config.loader).toMatchObject({ preset: "dots", intervalMs: 120, frames: [] });
    expect(result.config.description.wordCount).toBe(4);
    expect(result.config.icons.done).toBe("!");
  });

  it("applies registered global and local settings after JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tab-status-"));
    const globalValues: Record<string, string> = {
      enabled: "off",
      titleTemplate: "{{state}} {{description}}",
      titleMaxLength: "120",
      shutdownTitle: "bye",
      loaderPreset: "pulse",
      loaderFrames: "[\"a\",\"b\"]",
      loaderIntervalMs: "140",
      iconIdle: "i",
      iconWorking: "w",
      iconAsking: "a",
      iconDone: "d",
      descriptionWordCount: "4",
      descriptionModel: "google/gemini-2.5-flash",
      descriptionRefreshEveryPrompts: "6"
    };
    getSettingMock.mockImplementation((_extension: string, id: string, _fallback: undefined, options: { scope: string }) => {
      if (options.scope === "local" && id === "descriptionWordCount") return "5";
      return options.scope === "global" ? globalValues[id] : undefined;
    });
    const result = await loadConfig(root, true, { XDG_CONFIG_HOME: join(root, "xdg") });
    expect(result.config.enabled).toBe(false);
    expect(result.config.titleTemplate).toBe("{{state}} {{description}}");
    expect(result.config.shutdownTitle).toBe("bye");
    expect(result.config.loader).toEqual({ preset: "pulse", frames: ["a", "b"], intervalMs: 140 });
    expect(result.config.icons).toEqual({ idle: "i", working: "w", asking: "a", done: "d" });
    expect(result.config.titleMaxLength).toBe(120);
    expect(result.config.description).toEqual({ wordCount: 5, model: "google/gemini-2.5-flash", refreshEveryPrompts: 6 });
    expect(getSettingMock).toHaveBeenCalledWith("pi-tab-status", "enabled", undefined, expect.objectContaining({ scope: "global", cwd: root }));
  });

  it("reports invalid registered settings and skips local settings when untrusted", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tab-status-"));
    getSettingMock.mockImplementation((_extension: string, id: string, _fallback: undefined, options: { scope: string }) => {
      if (id === "enabled") return "maybe";
      if (id === "loaderFrames") return "not-json";
      if (options.scope === "local" && id === "descriptionWordCount") return "4";
      return undefined;
    });
    const result = await loadConfig(root, false, { XDG_CONFIG_HOME: join(root, "xdg") });
    expect(result.config.enabled).toBe(true);
    expect(result.config.description.wordCount).toBe(2);
    expect(result.warnings.join(" ")).toContain("global extension settings");
    expect(getSettingMock.mock.calls.some((call) => call[3]?.scope === "local")).toBe(false);
  });

  it("does not read project overrides for untrusted projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tab-status-"));
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi", "pi-tab-status.json"), JSON.stringify({ enabled: false }));
    const result = await loadConfig(root, false, { XDG_CONFIG_HOME: join(root, "xdg") });
    expect(result.config.enabled).toBe(true);
  });

  it("falls back field-by-field and reports malformed input", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tab-status-"));
    const file = join(root, "pi-tab-status", "config.json");
    await mkdir(join(root, "pi-tab-status"));
    await writeFile(file, JSON.stringify({ enabled: "yes", titleMaxLength: 10, extra: true, loader: { intervalMs: 1 } }));
    const result = await loadConfig(root, true, { XDG_CONFIG_HOME: root });
    expect(result.config.enabled).toBe(true);
    expect(result.config.titleMaxLength).toBe(10);
    expect(result.config.loader.intervalMs).toBe(75);
    expect(result.warnings.length).toBeGreaterThanOrEqual(3);
    await writeFile(file, "{");
    expect((await loadConfig(root, true, { XDG_CONFIG_HOME: root })).warnings[0]).toContain(file);
    await mkdir(join(root, "project", ".pi"), { recursive: true });
    await writeFile(join(root, "project", ".pi", "pi-tab-status.json"), "{");
    expect((await loadConfig(join(root, "project"), true, { XDG_CONFIG_HOME: join(root, "empty") })).warnings[0]).toContain("pi-tab-status.json");
  });

  it("strictly validates all supported groups", () => {
    const valid = validateConfig({
      enabled: false,
      titleTemplate: "{{state}} {{description}}",
      titleMaxLength: 99,
      shutdownTitle: "bye",
      loader: { preset: "pulse", frames: ["x"], intervalMs: 100 },
      icons: { idle: "i", working: "w", asking: "a", done: "d" },
      description: { wordCount: 3, model: "google/gemini-2.5-flash", refreshEveryPrompts: 0 }
    });
    expect(valid.errors).toEqual([]);
    expect(valid.config?.loader.frames).toEqual(["x"]);
    expect(validateConfig({ description: { model: "" } }).config?.description.model).toBe("");
    expect(validateConfig({ description: { model: "openrouter/free" } }).config?.description.model).toBe("openrouter/free");
    expect(validateConfig({ description: { model: "openrouter/vendor/model:free" } }).config?.description.model).toBe("openrouter/vendor/model:free");

    const invalid = validateConfig({
      unknown: true,
      titleTemplate: "{{bad}}",
      titleMaxLength: 0,
      shutdownTitle: 1,
      loader: { preset: "bad", frames: "x", intervalMs: 3, bad: true },
      icons: { done: 1, bad: "x" },
      description: { wordCount: 0, model: "bad", refreshEveryPrompts: -1, bad: true }
    });
    expect(invalid.config).toBeUndefined();
    expect(invalid.errors.length).toBeGreaterThan(10);
    expect(validateConfig([]).config).toBeUndefined();
    expect(validateConfig({ loader: null, icons: [], description: "bad" }).errors).toHaveLength(3);
    expect(validateConfig({ titleTemplate: 4, loader: { preset: 1 }, description: { model: 3 } }).config).toBeUndefined();
  });

  it("atomically saves normalized global JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tab-status-"));
    const path = join(root, "nested", "config.json");
    await saveGlobalConfig({
      ...DEFAULT_CONFIG,
      loader: { ...DEFAULT_CONFIG.loader, frames: ["x"] },
      icons: { ...DEFAULT_CONFIG.icons },
      description: { ...DEFAULT_CONFIG.description }
    }, path);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ loader: { frames: ["x"] } });
  });
});
