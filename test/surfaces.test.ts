import { describe, expect, it, vi } from "vitest";
import { SurfaceManager } from "../src/surfaces.js";

type Call = { command: string; args: string[]; timeout: number | undefined };

function harness(env: Record<string, string | undefined> = {}) {
  const calls: Call[] = [];
  let sessionName: string | undefined = "manual-before-first";
  const current = new Map<string, string>([
    ["tmux", "shell"],
    ["herdr-pane", "shell"],
    ["herdr-tab", "Tab 1"],
    ["zellij-pane", "bash"],
    ["zellij-tab", "Tab #1"]
  ]);
  const pi = {
    getSessionName: vi.fn(() => sessionName),
    setSessionName: vi.fn((name: string) => { sessionName = name; }),
    exec: vi.fn(async (command: string, args: string[], options?: { timeout?: number }) => {
      calls.push({ command, args, timeout: options?.timeout });
      if (command === "tmux" && args[0] === "display-message") return { stdout: `${current.get("tmux")}\n`, stderr: "", code: 0, killed: false };
      if (command === "tmux" && args[0] === "rename-window") current.set("tmux", args.at(-1) ?? "");
      if (command === "herdr" && args[0] === "pane" && args[1] === "get") return { stdout: JSON.stringify({ pane: { label: current.get("herdr-pane"), tab_id: "tab-1" } }), stderr: "", code: 0, killed: false };
      if (command === "herdr" && args[0] === "tab" && args[1] === "get") return { stdout: JSON.stringify({ tab: { label: current.get("herdr-tab") } }), stderr: "", code: 0, killed: false };
      if (command === "herdr" && args[1] === "rename") current.set(args[0] === "pane" ? "herdr-pane" : "herdr-tab", args.at(-1) ?? "");
      if (command === "zellij" && args[1] === "list-panes") return { stdout: JSON.stringify([{ id: 2, title: current.get("zellij-pane"), tab_id: 7, tab_name: current.get("zellij-tab") }]), stderr: "", code: 0, killed: false };
      if (command === "zellij" && args[1] === "rename-pane") current.set("zellij-pane", args.at(-1) ?? "");
      if (command === "zellij" && args[1] === "rename-tab") current.set("zellij-tab", args.at(-1) ?? "");
      return { stdout: "", stderr: "", code: 0, killed: false };
    })
  };
  return { pi, calls, current, manager: new SurfaceManager(pi as never, () => env), setSessionName: (name: string) => { sessionName = name; } };
}

describe("stable naming surfaces", () => {
  it("auto-detects and renames all surfaces with exact argument arrays", async () => {
    const env = {
      TMUX: "/tmp/tmux", TMUX_PANE: "%4",
      HERDR_ENV: "1", HERDR_PANE_ID: "pane-1", HERDR_TAB_ID: "tab-1",
      ZELLIJ: "1", ZELLIJ_PANE_ID: "2"
    };
    const h = harness(env);
    expect(h.manager.detected()).toEqual(["piSession", "tmuxWindow", "herdrPane", "herdrTab", "zellijPane", "zellijTab"]);
    await h.manager.apply("Fix Tests");
    expect(h.pi.setSessionName).toHaveBeenCalledWith("Fix Tests");
    expect(h.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "tmux", args: ["rename-window", "-t", "%4", "Fix Tests"], timeout: 3000 }),
      expect.objectContaining({ command: "herdr", args: ["pane", "rename", "pane-1", "Fix Tests"] }),
      expect.objectContaining({ command: "herdr", args: ["tab", "rename", "tab-1", "Fix Tests"] }),
      expect.objectContaining({ command: "zellij", args: ["action", "rename-pane", "-p", "2", "Fix Tests"] }),
      expect.objectContaining({ command: "zellij", args: ["action", "rename-tab", "-t", "7", "Fix Tests"] })
    ]));

    await h.manager.apply("Next Name");
    expect(h.current.get("tmux")).toBe("Next Name");
    expect(h.current.get("herdr-pane")).toBe("Next Name");
    expect(h.current.get("herdr-tab")).toBe("Next Name");
    expect(h.current.get("zellij-pane")).toBe("Next Name");
    expect(h.current.get("zellij-tab")).toBe("Next Name");
  });

  it("does nothing outside multiplexers except name the Pi session", async () => {
    const h = harness({});
    expect(h.manager.detected()).toEqual(["piSession"]);
    await h.manager.apply("Name");
    expect(h.calls).toEqual([]);
    expect(h.pi.setSessionName).toHaveBeenCalledWith("Name");
  });

  it("respects external changes after its first rename", async () => {
    const h = harness({ TMUX: "1", TMUX_PANE: "%1" });
    await h.manager.apply("First");
    h.current.set("tmux", "Manual");
    h.setSessionName("Manual Session");
    await h.manager.apply("Second");
    expect(h.current.get("tmux")).toBe("Manual");
    expect(h.pi.setSessionName).toHaveBeenCalledTimes(1);
    expect(h.manager.managed()).not.toContain("tmuxWindow");
    expect(h.manager.managed()).not.toContain("piSession");
  });

  it("handles session event echoes and restores ownership", () => {
    const h = harness();
    h.manager.restore({ piSession: { lastApplied: "Own" } });
    h.manager.handleSessionInfoChanged("Own");
    expect(h.manager.managed()).toContain("piSession");
    h.manager.handleSessionInfoChanged("Manual");
    expect(h.manager.snapshot().piSession?.locked).toBe(true);
  });

  it("falls back to herdr pane current and ignores process failures", async () => {
    const h = harness({ HERDR_ENV: "1" });
    h.pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === "herdr" && args[0] === "pane" && args[1] === "current") {
        return { stdout: JSON.stringify({ result: { pane: { pane_id: "p", tab_id: "t" } } }), stderr: "", code: 0, killed: false };
      }
      if (args.includes("rename")) throw new Error("missing");
      return { stdout: "not json", stderr: "", code: 1, killed: false };
    });
    await expect(h.manager.apply("Name")).resolves.toBeUndefined();
    await expect(h.manager.apply("\u0000")).resolves.toBeUndefined();
  });

  it("handles missing IDs, malformed JSON, locked snapshots, and alternate herdr labels", async () => {
    const h = harness({ HERDR_ENV: "1", ZELLIJ: "1", ZELLIJ_PANE_ID: "9" });
    h.manager.restore({
      piSession: { locked: true },
      herdrPane: { lastApplied: "Old" },
      herdrTab: { lastApplied: "Old" },
      zellijPane: { lastApplied: "Old" },
      zellijTab: { lastApplied: "Old" }
    });
    h.pi.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === "herdr" && args[1] === "current") return { stdout: JSON.stringify({ result: { pane: { pane_id: "p" } } }), stderr: "", code: 0, killed: false };
      if (command === "herdr" && args[0] === "pane" && args[1] === "get") return { stdout: JSON.stringify({ pane: { pane_label: "Old", tab_id: "t" } }), stderr: "", code: 0, killed: false };
      if (command === "herdr" && args[0] === "tab" && args[1] === "get") return { stdout: JSON.stringify({ tab: { label: "Old" } }), stderr: "", code: 0, killed: false };
      if (command === "zellij") return { stdout: "not-json", stderr: "", code: 0, killed: false };
      return { stdout: "", stderr: "", code: 0, killed: false };
    });
    await expect(h.manager.apply("New")).resolves.toBeUndefined();
    expect(h.pi.setSessionName).not.toHaveBeenCalled();
    expect(() => (h.manager as any).state("missing")).toThrow("Unknown surface");
  });
});
