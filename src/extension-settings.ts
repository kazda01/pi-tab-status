import {
  getSetting,
  type SettingDefinition
} from "@juanibiapina/pi-extension-settings";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "./config.js";

export const SETTINGS_EXTENSION_NAME = "pi-tab-status";

export const SETTING_DEFINITIONS = [
  {
    id: "enabled",
    label: "Enabled",
    description: "Enable terminal title status updates",
    defaultValue: "on",
    values: ["on", "off"]
  },
  {
    id: "titleTemplate",
    label: "Title template",
    description: "Template using state, loader, statusIcon, indicator, and description variables",
    defaultValue: DEFAULT_CONFIG.titleTemplate
  },
  {
    id: "titleMaxLength",
    label: "Title maximum length",
    description: "Maximum number of Unicode graphemes in the terminal title",
    defaultValue: String(DEFAULT_CONFIG.titleMaxLength)
  },
  {
    id: "shutdownTitle",
    label: "Shutdown title",
    description: "Terminal title restored when Pi exits",
    defaultValue: DEFAULT_CONFIG.shutdownTitle
  },
  {
    id: "loaderPreset",
    label: "Loader preset",
    description: "Animation used while Pi is working",
    defaultValue: DEFAULT_CONFIG.loader.preset,
    values: ["braille", "dots", "line", "bounce", "pulse", "none"]
  },
  {
    id: "loaderFrames",
    label: "Custom loader frames",
    description: "JSON array of frames; [] uses the selected preset",
    defaultValue: "[]"
  },
  {
    id: "loaderIntervalMs",
    label: "Loader interval (ms)",
    description: "Animation interval from 40 to 2000 milliseconds",
    defaultValue: String(DEFAULT_CONFIG.loader.intervalMs)
  },
  {
    id: "iconIdle",
    label: "Idle icon",
    description: "Static icon for the idle state",
    defaultValue: DEFAULT_CONFIG.icons.idle
  },
  {
    id: "iconWorking",
    label: "Working icon",
    description: "Fallback icon when the working loader has no frames",
    defaultValue: DEFAULT_CONFIG.icons.working
  },
  {
    id: "iconAsking",
    label: "Asking icon",
    description: "Icon shown while Pi waits for an answer",
    defaultValue: DEFAULT_CONFIG.icons.asking
  },
  {
    id: "iconDone",
    label: "Done icon",
    description: "Icon shown when Pi settles",
    defaultValue: DEFAULT_CONFIG.icons.done
  },
  {
    id: "descriptionWordCount",
    label: "Description word count",
    description: "Requested short-description length from 1 to 12 words",
    defaultValue: String(DEFAULT_CONFIG.description.wordCount)
  },
  {
    id: "descriptionModel",
    label: "Description model",
    description: "Required for descriptions: one provider/modelId; no active-model fallback",
    defaultValue: DEFAULT_CONFIG.description.model
  },
  {
    id: "descriptionRefreshEveryPrompts",
    label: "Description refresh prompts",
    description: "Regenerate every N prompts; 0 means only once",
    defaultValue: String(DEFAULT_CONFIG.description.refreshEveryPrompts)
  }
] satisfies SettingDefinition[];

export type SettingsScope = "global" | "local";
export type ExtensionSettingReader = (
  settingId: string,
  scope: SettingsScope,
  cwd: string
) => string | undefined;

export const readExtensionSetting: ExtensionSettingReader = (settingId, scope, cwd) =>
  getSetting(SETTINGS_EXTENSION_NAME, settingId, undefined, { scope, cwd });

export function registerExtensionSettings(pi: Pick<ExtensionAPI, "events">): void {
  pi.events.emit("pi-extension-settings:register", {
    name: SETTINGS_EXTENSION_NAME,
    settings: SETTING_DEFINITIONS
  });
}
