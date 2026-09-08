import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { getSetting } from "@juanibiapina/pi-extension-settings";
import { compileTemplate } from "./template.js";
import type {
  ConfigLoadResult,
  LoaderPreset,
  StatusState,
  TabStatusConfig
} from "./types.js";

const PRESETS = new Set<LoaderPreset>(["braille", "dots", "line", "bounce", "pulse", "none"]);
const STATES: StatusState[] = ["idle", "working", "asking", "done"];
const ROOT_KEYS = new Set(["enabled", "titleTemplate", "titleMaxLength", "shutdownTitle", "loader", "icons", "description"]);
const EXTENSION_SETTINGS_NAME = "pi-tab-status";

export type ExtensionSettingsScope = "global" | "local";
export type ExtensionSettingReader = (
  settingId: string,
  scope: ExtensionSettingsScope,
  cwd: string
) => string | undefined;

export const readExtensionSetting: ExtensionSettingReader = (settingId, scope, cwd) =>
  getSetting(EXTENSION_SETTINGS_NAME, settingId, undefined, { scope, cwd });

export const DEFAULT_CONFIG: Readonly<TabStatusConfig> = Object.freeze({
  enabled: true,
  titleTemplate: "π{{#indicator}} {{indicator}} {{description}}{{/indicator}}",
  titleMaxLength: 80,
  shutdownTitle: "π",
  loader: Object.freeze({ preset: "braille", frames: Object.freeze([]) as unknown as string[], intervalMs: 75 }),
  icons: Object.freeze({ idle: "", working: "", asking: "?", done: "✓" }),
  description: Object.freeze({
    wordCount: 2,
    model: "",
    refreshEveryPrompts: 3
  })
});

function cloneDefaults(): TabStatusConfig {
  return {
    ...DEFAULT_CONFIG,
    loader: { ...DEFAULT_CONFIG.loader, frames: [...DEFAULT_CONFIG.loader.frames] },
    icons: { ...DEFAULT_CONFIG.icons },
    description: { ...DEFAULT_CONFIG.description }
  };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function parseModelKey(value: string): { provider: string; modelId: string } | undefined {
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function validateAndApply(
  target: TabStatusConfig,
  input: unknown,
  source: string,
  strict: boolean
): string[] {
  const errors: string[] = [];
  const problem = (message: string): void => {
    errors.push(`${source}: ${message}`);
  };
  if (!plainObject(input)) {
    problem("configuration must be a JSON object");
    return errors;
  }

  for (const key of Object.keys(input)) {
    if (!ROOT_KEYS.has(key)) problem(`unknown key '${key}'`);
  }

  if ("enabled" in input) {
    if (typeof input.enabled === "boolean") target.enabled = input.enabled;
    else problem("enabled must be a boolean");
  }
  if ("titleTemplate" in input) {
    if (typeof input.titleTemplate !== "string") problem("titleTemplate must be a string");
    else {
      try {
        compileTemplate(input.titleTemplate);
        target.titleTemplate = input.titleTemplate;
      } catch (error) {
        problem(`titleTemplate is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if ("titleMaxLength" in input) {
    if (integerIn(input.titleMaxLength, 1, 512)) target.titleMaxLength = input.titleMaxLength;
    else problem("titleMaxLength must be an integer from 1 to 512");
  }
  if ("shutdownTitle" in input) {
    if (typeof input.shutdownTitle === "string") target.shutdownTitle = input.shutdownTitle;
    else problem("shutdownTitle must be a string");
  }

  if ("loader" in input) {
    if (!plainObject(input.loader)) problem("loader must be an object");
    else {
      const allowed = new Set(["preset", "frames", "intervalMs"]);
      for (const key of Object.keys(input.loader)) if (!allowed.has(key)) problem(`unknown loader key '${key}'`);
      if ("preset" in input.loader) {
        if (typeof input.loader.preset === "string" && PRESETS.has(input.loader.preset as LoaderPreset)) {
          target.loader.preset = input.loader.preset as LoaderPreset;
        } else problem(`loader.preset must be one of ${[...PRESETS].join(", ")}`);
      }
      if ("frames" in input.loader) {
        if (
          Array.isArray(input.loader.frames) &&
          input.loader.frames.length <= 64 &&
          input.loader.frames.every((frame) => typeof frame === "string" && frame.length <= 64)
        ) target.loader.frames = [...input.loader.frames];
        else problem("loader.frames must be an array of at most 64 short strings");
      }
      if ("intervalMs" in input.loader) {
        if (integerIn(input.loader.intervalMs, 40, 2000)) target.loader.intervalMs = input.loader.intervalMs;
        else problem("loader.intervalMs must be an integer from 40 to 2000");
      }
    }
  }

  if ("icons" in input) {
    if (!plainObject(input.icons)) problem("icons must be an object");
    else {
      for (const key of Object.keys(input.icons)) if (!STATES.includes(key as StatusState)) problem(`unknown icons key '${key}'`);
      for (const state of STATES) {
        if (!(state in input.icons)) continue;
        const icon = input.icons[state];
        if (typeof icon === "string" && icon.length <= 64) target.icons[state] = icon;
        else problem(`icons.${state} must be a short string`);
      }
    }
  }

  if ("description" in input) {
    if (!plainObject(input.description)) problem("description must be an object");
    else {
      const allowed = new Set(["wordCount", "model", "refreshEveryPrompts"]);
      for (const key of Object.keys(input.description)) if (!allowed.has(key)) problem(`unknown description key '${key}'`);
      if ("wordCount" in input.description) {
        if (integerIn(input.description.wordCount, 1, 12)) target.description.wordCount = input.description.wordCount;
        else problem("description.wordCount must be an integer from 1 to 12");
      }
      if ("model" in input.description) {
        if (typeof input.description.model !== "string") {
          problem("description.model must be a string");
        } else {
          const model = input.description.model.trim();
          if (!model) target.description.model = "";
          else if (parseModelKey(model)) target.description.model = model;
          else problem("description.model must use provider/modelId");
        }
      }
      if ("refreshEveryPrompts" in input.description) {
        if (integerIn(input.description.refreshEveryPrompts, 0, 1000)) {
          target.description.refreshEveryPrompts = input.description.refreshEveryPrompts;
        } else problem("description.refreshEveryPrompts must be an integer from 0 to 1000");
      }
    }
  }

  if (strict && errors.length > 0) return errors;
  return errors;
}

export function validateConfig(input: unknown): { config?: TabStatusConfig; errors: string[] } {
  const config = cloneDefaults();
  const errors = validateAndApply(config, input, "config", true);
  return errors.length > 0 ? { errors } : { config, errors: [] };
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.XDG_CONFIG_HOME?.trim();
  let base: string;
  if (!raw) base = join(homedir(), ".config");
  else if (raw === "~") base = homedir();
  else if (raw.startsWith("~/")) base = join(homedir(), raw.slice(2));
  else base = isAbsolute(raw) ? raw : join(homedir(), ".config");
  return join(base, "pi-tab-status", "config.json");
}

function registeredSettingsLayer(
  reader: ExtensionSettingReader,
  scope: ExtensionSettingsScope,
  cwd: string
): Record<string, unknown> {
  const cache = new Map<string, string | undefined>();
  const get = (id: string): string | undefined => {
    if (!cache.has(id)) cache.set(id, reader(id, scope, cwd));
    return cache.get(id);
  };
  const numbers = new Map<string, number | undefined>();
  const numberValue = (id: string): number | undefined => {
    if (!numbers.has(id)) {
      const value = get(id);
      numbers.set(id, value === undefined ? undefined : Number(value));
    }
    return numbers.get(id);
  };
  const enabled = get("enabled");
  const frames = get("loaderFrames");
  let parsedFrames: unknown = undefined;
  if (frames !== undefined) {
    try {
      parsedFrames = JSON.parse(frames) as unknown;
    } catch {
      parsedFrames = frames;
    }
  }

  const loader = {
    ...(get("loaderPreset") !== undefined ? { preset: get("loaderPreset") } : {}),
    ...(frames !== undefined ? { frames: parsedFrames } : {}),
    ...(numberValue("loaderIntervalMs") !== undefined ? { intervalMs: numberValue("loaderIntervalMs") } : {})
  };
  const icons = {
    ...(get("iconIdle") !== undefined ? { idle: get("iconIdle") } : {}),
    ...(get("iconWorking") !== undefined ? { working: get("iconWorking") } : {}),
    ...(get("iconAsking") !== undefined ? { asking: get("iconAsking") } : {}),
    ...(get("iconDone") !== undefined ? { done: get("iconDone") } : {})
  };
  const description = {
    ...(numberValue("descriptionWordCount") !== undefined ? { wordCount: numberValue("descriptionWordCount") } : {}),
    ...(get("descriptionModel") !== undefined ? { model: get("descriptionModel") } : {}),
    ...(numberValue("descriptionRefreshEveryPrompts") !== undefined
      ? { refreshEveryPrompts: numberValue("descriptionRefreshEveryPrompts") }
      : {})
  };

  return {
    ...(enabled !== undefined ? { enabled: enabled === "on" ? true : enabled === "off" ? false : enabled } : {}),
    ...(get("titleTemplate") !== undefined ? { titleTemplate: get("titleTemplate") } : {}),
    ...(numberValue("titleMaxLength") !== undefined ? { titleMaxLength: numberValue("titleMaxLength") } : {}),
    ...(get("shutdownTitle") !== undefined ? { shutdownTitle: get("shutdownTitle") } : {}),
    ...(Object.keys(loader).length > 0 ? { loader } : {}),
    ...(Object.keys(icons).length > 0 ? { icons } : {}),
    ...(Object.keys(description).length > 0 ? { description } : {})
  };
}

async function readConfigFile(path: string): Promise<{ value?: unknown; warning?: string }> {
  try {
    const text = await readFile(path, "utf8");
    return { value: JSON.parse(text) as unknown };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    return { warning: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function loadConfig(
  cwd: string,
  projectTrusted: boolean,
  env: NodeJS.ProcessEnv = process.env,
  settingReader: ExtensionSettingReader = readExtensionSetting
): Promise<ConfigLoadResult> {
  const config = cloneDefaults();
  const warnings: string[] = [];
  const globalPath = globalConfigPath(env);
  const projectPath = join(cwd, CONFIG_DIR_NAME, "pi-tab-status.json");
  const global = await readConfigFile(globalPath);
  if (global.warning) warnings.push(global.warning);
  if (global.value !== undefined) warnings.push(...validateAndApply(config, global.value, globalPath, false));
  if (projectTrusted) {
    const project = await readConfigFile(projectPath);
    if (project.warning) warnings.push(project.warning);
    if (project.value !== undefined) warnings.push(...validateAndApply(config, project.value, projectPath, false));
  }

  const globalRegistered = registeredSettingsLayer(settingReader, "global", cwd);
  warnings.push(...validateAndApply(config, globalRegistered, "global extension settings", false));
  if (projectTrusted) {
    const localRegistered = registeredSettingsLayer(settingReader, "local", cwd);
    warnings.push(...validateAndApply(config, localRegistered, "local extension settings", false));
  }
  return { config, globalPath, projectPath, warnings };
}

export async function saveGlobalConfig(config: TabStatusConfig, path = globalConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
    await access(path, constants.R_OK | constants.W_OK);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
