import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { generateDescriptionMock, getSettingMock } = vi.hoisted(() => ({
  generateDescriptionMock: vi.fn(),
  getSettingMock: vi.fn()
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".pi",
  BorderedLoader: class {
    onAbort?: () => void;
    signal = new AbortController().signal;
    constructor(..._args: unknown[]) {}
  }
}));

vi.mock("@juanibiapina/pi-extension-settings", () => ({ getSetting: getSettingMock }));

vi.mock("../src/description.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/description.js")>();
  return { ...actual, generateDescription: generateDescriptionMock };
});

import tabStatusExtension, { ENTRY_TYPE, LEGACY_ENTRY_TYPE } from "../src/index.js";

type Handler = (...args: any[]) => any;

function makeHarness(root: string, options: { mode?: "tui" | "print"; hasUI?: boolean; branch?: any[]; customResult?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>();
  const eventBusHandlers = new Map<string, Handler[]>();
  const emittedEvents: Array<{ name: string; data: unknown }> = [];
  const commands = new Map<string, any>();
  const titles: string[] = [];
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const entries: Array<{ type: string; data: any }> = [];
  let sessionName: string | undefined;
  let branch = options.branch ?? [{ type: "message", message: { role: "user", content: "Build package" } }];

  const ui = {
    setTitle: vi.fn((title: string) => titles.push(title)),
    notify: vi.fn((message: string, type?: string) => notifications.push({ message, type })),
    editor: vi.fn<(...args: any[]) => Promise<string | undefined>>(async () => undefined),
    custom: vi.fn(async (factory: any) => {
      if (options.customResult !== undefined) return options.customResult;
      return await new Promise<boolean>((resolve) => {
        factory({ requestRender() {} }, {}, {}, resolve);
      });
    })
  };
  const ctx = {
    cwd: root,
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "tui",
    signal: undefined,
    ui,
    isProjectTrusted: () => true,
    sessionManager: {
      getBranch: () => branch,
      getSessionFile: () => join(root, "session.jsonl")
    },
    modelRegistry: {},
    model: { provider: "active", id: "model" }
  };
  const pi = {
    events: {
      on: vi.fn((name: string, handler: Handler) => {
        const list = eventBusHandlers.get(name) ?? [];
        list.push(handler);
        eventBusHandlers.set(name, list);
      }),
      emit: vi.fn((name: string, data: unknown) => {
        emittedEvents.push({ name, data });
        for (const handler of eventBusHandlers.get(name) ?? []) handler(data);
      })
    },
    on: vi.fn((name: string, handler: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    }),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    appendEntry: vi.fn((type: string, data: any) => entries.push({ type, data })),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 1, killed: false })),
    getSessionName: vi.fn(() => sessionName),
    setSessionName: vi.fn((name: string) => { sessionName = name; })
  };

  tabStatusExtension(pi as never);

  return {
    pi,
    ctx,
    ui,
    titles,
    notifications,
    entries,
    emittedEvents,
    commands,
    setBranch(next: any[]) { branch = next; },
    async emit(name: string, event: any = {}) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    }
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

beforeEach(() => {
  generateDescriptionMock.mockReset();
  getSettingMock.mockReset();
  getSettingMock.mockReturnValue(undefined);
  generateDescriptionMock.mockResolvedValue({ description: "Package Tests", attemptedModels: ["mock/model"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("extension runtime", () => {
  it("drives lifecycle, loader animation, question state, persistence, and shutdown", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "pi-tab-status-index-"));
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
    const h = makeHarness(root);

    expect(h.emittedEvents[0]).toMatchObject({ name: "pi-extension-settings:register", data: { name: "pi-tab-status" } });
    await h.emit("session_start", { reason: "startup" });
    expect(h.emittedEvents.filter((event) => event.name === "pi-extension-settings:register")).toHaveLength(2);
    expect(h.titles.at(-1)).toBe("π");

    await h.emit("before_agent_start", { prompt: "Build package" });
    expect(h.titles.at(-1)).toContain("⠋");
    vi.advanceTimersByTime(75);
    expect(h.titles.at(-1)).toContain("⠙");
    await flush();
    expect(h.pi.setSessionName).toHaveBeenCalledWith("Package Tests");
    expect(h.entries.at(-1)).toMatchObject({ type: ENTRY_TYPE, data: { version: 1, description: "Package Tests" } });

    await h.emit("tool_call", { toolName: "ask_user_question", toolCallId: "a" });
    await h.emit("tool_call", { toolName: "plan_mode_question", toolCallId: "b" });
    expect(h.titles.at(-1)).toContain("?");
    await h.emit("tool_result", { toolName: "ask_user_question", toolCallId: "a" });
    expect(h.titles.at(-1)).toContain("?");
    await h.emit("tool_result", { toolName: "plan_mode_question", toolCallId: "b" });
    expect(h.titles.at(-1)).toContain("⠋");
    await h.emit("tool_call", { toolName: "read", toolCallId: "c" });
    await h.emit("tool_result", { toolName: "read", toolCallId: "c" });

    await h.emit("agent_start");
    await h.emit("agent_settled");
    expect(h.titles.at(-1)).toBe("π ✓ Package Tests");

    const callsAfterInitial = generateDescriptionMock.mock.calls.length;
    await h.emit("before_agent_start", { prompt: "second" });
    await h.emit("before_agent_start", { prompt: "third" });
    await flush();
    expect(generateDescriptionMock).toHaveBeenCalledTimes(callsAfterInitial);
    await h.emit("before_agent_start", { prompt: "fourth" });
    await flush();
    expect(generateDescriptionMock).toHaveBeenCalledTimes(callsAfterInitial + 1);

    await h.emit("session_info_changed", { name: "Manual" });
    await h.emit("session_shutdown", { reason: "quit" });
    expect(h.titles.at(-1)).toBe("π");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores current and legacy entries across tree navigation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tab-status-index-"));
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
    const h = makeHarness(root, {
      branch: [{
        type: "custom",
        customType: ENTRY_TYPE,
        data: { version: 1, description: "Saved Description Extra", descriptionPromptCount: 4, surfaces: {} }
      }]
    });
    await h.emit("session_start");
    expect(h.pi.setSessionName).toHaveBeenCalledWith("Saved Description");
    expect(h.titles.at(-1)).toBe("π");

    h.setBranch([{ type: "custom", customType: LEGACY_ENTRY_TYPE, data: { description: "Legacy Name", promptCount: 2 } }]);
    await h.emit("session_tree");
    expect(h.pi.setSessionName).toHaveBeenCalledWith("Legacy Name");
    expect(h.titles.at(-1)).toBe("π");

    h.setBranch([{ type: "custom", customType: ENTRY_TYPE, data: { description: "---" } }]);
    await h.emit("session_tree");
    expect(h.titles.at(-1)).not.toContain("Legacy Name");
  });

  it("supports status, preview, reload, and centralized setting changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tab-status-index-"));
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
    const h = makeHarness(root);
    await h.emit("session_start");
    const command = h.commands.get("tab-status");
    expect(command.getArgumentCompletions("re")).toEqual([{ value: "reload", label: "reload" }, { value: "regenerate", label: "regenerate" }]);
    expect(command.getArgumentCompletions("zzz")).toBeNull();

    await command.handler("", h.ctx);
    expect(h.notifications.at(-1)?.message).toContain("description on");
    await command.handler("preview", h.ctx);
    expect(h.notifications.at(-1)?.message).toContain("working:");

    getSettingMock.mockImplementation((_extension: string, id: string) => id === "titleTemplate" ? "{{state}}" : undefined);
    await command.handler("reload", h.ctx);
    expect(h.notifications.at(-1)?.message).toContain("Reloaded");
    const before = generateDescriptionMock.mock.calls.length;
    await h.emit("before_agent_start", { prompt: "No naming call" });
    await flush();
    expect(generateDescriptionMock).toHaveBeenCalledTimes(before);
    await command.handler("regenerate", h.ctx);
    expect(h.notifications.at(-1)?.message).toContain("Add {{description}}");
    await command.handler("unknown", h.ctx);
    expect(h.notifications.at(-1)?.type).toBe("error");
  });

  it("regenerates manually and handles no-prompt and non-TUI command paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tab-status-index-"));
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
    const h = makeHarness(root);
    await h.emit("session_start");
    const command = h.commands.get("tab-status");
    await command.handler("regenerate", h.ctx);
    expect(h.notifications.at(-1)?.message).toContain("Description: Package Tests");

    h.setBranch([]);
    await command.handler("regenerate", h.ctx);
    expect(h.notifications.at(-1)?.message).toContain("No user prompt");

    const cancelled = makeHarness(root, { customResult: false });
    await cancelled.emit("session_start");
    await cancelled.commands.get("tab-status").handler("regenerate", cancelled.ctx);
    expect(cancelled.notifications.at(-1)?.type).toBe("warning");

    const nonTui = makeHarness(root, { mode: "print", hasUI: false, customResult: false });
    await nonTui.emit("session_start");
    const nonTuiCommand = nonTui.commands.get("tab-status");
    await nonTuiCommand.handler("preview", nonTui.ctx);
    expect(nonTui.notifications.at(-1)?.type).toBe("error");
    await nonTuiCommand.handler("regenerate", nonTui.ctx);
    expect(nonTui.notifications.at(-1)?.type).toBe("error");
    await nonTuiCommand.handler("settings", nonTui.ctx);
    expect(nonTui.notifications.at(-1)?.type).toBe("error");
  });

  it("keeps old description on failed generation and handles disabled extension", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tab-status-index-"));
    const xdg = join(root, "xdg");
    await import("node:fs/promises").then(({ mkdir, writeFile }) =>
      mkdir(join(xdg, "pi-tab-status"), { recursive: true }).then(() =>
        writeFile(join(xdg, "pi-tab-status", "config.json"), JSON.stringify({ enabled: false }))
      )
    );
    vi.stubEnv("XDG_CONFIG_HOME", xdg);
    generateDescriptionMock.mockResolvedValue({ attemptedModels: [] });
    const h = makeHarness(root);
    await h.emit("session_start");
    await h.emit("before_agent_start", { prompt: "ignored" });
    await flush();
    expect(generateDescriptionMock).not.toHaveBeenCalled();
    expect(h.titles.at(-1)).toBe("π");
  });

  it("warns on bad startup config and keeps state on empty generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tab-status-index-"));
    const xdg = join(root, "xdg");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(xdg, "pi-tab-status"), { recursive: true });
    await writeFile(join(xdg, "pi-tab-status", "config.json"), JSON.stringify({ titleMaxLength: 0 }));
    vi.stubEnv("XDG_CONFIG_HOME", xdg);
    generateDescriptionMock.mockResolvedValue({ attemptedModels: [] });
    const h = makeHarness(root);
    await h.emit("session_start");
    expect(h.notifications.at(-1)?.type).toBe("warning");
    await h.emit("before_agent_start", { prompt: "fails" });
    await flush();
    expect(h.entries).toHaveLength(0);
    await h.emit("agent_settled");
  });

  it("reports description-model errors without silently retrying the active model", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tab-status-index-"));
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
    generateDescriptionMock.mockRejectedValue(new Error("No description model is configured"));
    const h = makeHarness(root);
    await h.emit("session_start");
    await h.emit("before_agent_start", { prompt: "task" });
    await flush();
    expect(h.notifications.at(-1)).toEqual(expect.objectContaining({
      message: expect.stringContaining("No description model is configured"),
      type: "error"
    }));
    const notificationCount = h.notifications.length;
    await h.emit("before_agent_start", { prompt: "another task" });
    await flush();
    expect(h.notifications).toHaveLength(notificationCount);
  });

  it("does not touch UI without hasUI and handles a stopped animation callback", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "pi-tab-status-index-"));
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
    const h = makeHarness(root, { hasUI: false });
    await h.emit("session_start");
    await h.emit("before_agent_start", { prompt: "task" });
    await h.emit("agent_settled");
    vi.runOnlyPendingTimers();
    await h.emit("session_shutdown");
    expect(h.titles).toEqual([]);
  });
});
