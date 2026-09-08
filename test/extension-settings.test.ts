import { describe, expect, it, vi } from "vitest";

const { getSettingMock } = vi.hoisted(() => ({ getSettingMock: vi.fn() }));
vi.mock("@juanibiapina/pi-extension-settings", () => ({ getSetting: getSettingMock }));

import {
  readExtensionSetting,
  registerExtensionSettings,
  SETTING_DEFINITIONS,
  SETTINGS_EXTENSION_NAME
} from "../src/extension-settings.js";

describe("central extension settings integration", () => {
  it("registers all package settings with pi-extension-settings", () => {
    const emit = vi.fn();
    registerExtensionSettings({ events: { emit } } as never);
    expect(emit).toHaveBeenCalledWith("pi-extension-settings:register", {
      name: SETTINGS_EXTENSION_NAME,
      settings: SETTING_DEFINITIONS
    });
    expect(SETTING_DEFINITIONS.map((setting) => setting.id)).toEqual(expect.arrayContaining([
      "enabled",
      "titleTemplate",
      "loaderPreset",
      "loaderFrames",
      "descriptionWordCount",
      "descriptionModel"
    ]));
  });

  it("reads global or local values through the shared storage helper", () => {
    getSettingMock.mockReturnValueOnce("pulse");
    expect(readExtensionSetting("loaderPreset", "local", "/project")).toBe("pulse");
    expect(getSettingMock).toHaveBeenCalledWith(
      "pi-tab-status",
      "loaderPreset",
      undefined,
      { scope: "local", cwd: "/project" }
    );
  });
});
