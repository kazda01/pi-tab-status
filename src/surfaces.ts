import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { safeTitle } from "./template.js";

export type SurfaceId =
  | "piSession"
  | "tmuxWindow"
  | "herdrPane"
  | "herdrTab"
  | "zellijPane"
  | "zellijTab";

export interface SurfaceOwnership {
  lastApplied?: string;
  locked?: boolean;
}

export type SurfaceOwnershipSnapshot = Partial<Record<SurfaceId, SurfaceOwnership>>;

type Env = Readonly<Record<string, string | undefined>>;
type SurfaceState = { lastApplied?: string; locked: boolean };

const SURFACES: SurfaceId[] = [
  "piSession",
  "tmuxWindow",
  "herdrPane",
  "herdrTab",
  "zellijPane",
  "zellijTab"
];

function parseJson<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export class SurfaceManager {
  private readonly states = new Map<SurfaceId, SurfaceState>();

  constructor(
    private readonly pi: Pick<ExtensionAPI, "exec" | "getSessionName" | "setSessionName">,
    private readonly getEnv: () => Env = () => process.env
  ) {
    this.restore();
  }

  restore(snapshot: SurfaceOwnershipSnapshot = {}): void {
    this.states.clear();
    for (const id of SURFACES) {
      const saved = snapshot[id];
      this.states.set(id, {
        ...(saved?.lastApplied ? { lastApplied: saved.lastApplied } : {}),
        locked: saved?.locked === true
      });
    }
  }

  snapshot(): SurfaceOwnershipSnapshot {
    const snapshot: SurfaceOwnershipSnapshot = {};
    for (const id of SURFACES) {
      const state = this.state(id);
      if (state.lastApplied || state.locked) {
        snapshot[id] = {
          ...(state.lastApplied ? { lastApplied: state.lastApplied } : {}),
          ...(state.locked ? { locked: true } : {})
        };
      }
    }
    return snapshot;
  }

  detected(): SurfaceId[] {
    const env = this.getEnv();
    const ids: SurfaceId[] = ["piSession"];
    if (env.TMUX && env.TMUX_PANE) ids.push("tmuxWindow");
    if (env.HERDR_ENV || env.HERDR_PANE_ID) ids.push("herdrPane", "herdrTab");
    if (env.ZELLIJ && env.ZELLIJ_PANE_ID) ids.push("zellijPane", "zellijTab");
    return ids;
  }

  managed(): SurfaceId[] {
    return SURFACES.filter((id) => !this.state(id).locked);
  }

  handleSessionInfoChanged(name: string | undefined): void {
    const state = this.state("piSession");
    if (!state.lastApplied || name === state.lastApplied) return;
    state.locked = true;
  }

  async apply(description: string): Promise<void> {
    const name = safeTitle(description, 30);
    if (!name) return;
    await this.applyPiSession(safeTitle(description, 200));
    await this.applyTmux(name);
    await this.applyHerdrPane(name);
    await this.applyHerdrTab(name);
    await this.applyZellijPane(name);
    await this.applyZellijTab(name);
  }

  private state(id: SurfaceId): SurfaceState {
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown surface: ${id}`);
    return state;
  }

  private shouldApply(id: SurfaceId, current: string | undefined): boolean {
    const state = this.state(id);
    if (state.locked) return false;
    if (state.lastApplied && current !== undefined && current !== state.lastApplied) {
      state.locked = true;
      return false;
    }
    return true;
  }

  private async exec(command: string, args: string[], timeout: number): Promise<string | undefined> {
    try {
      const result = await this.pi.exec(command, args, { timeout });
      return result.code === 0 ? result.stdout.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  private async renamed(id: SurfaceId, command: string, args: string[], timeout: number): Promise<void> {
    const output = await this.exec(command, args, timeout);
    const name = args.at(-1);
    if (output !== undefined && name !== undefined) this.state(id).lastApplied = name;
  }

  private async applyPiSession(name: string): Promise<void> {
    const state = this.state("piSession");
    if (!this.shouldApply("piSession", this.pi.getSessionName())) return;
    state.lastApplied = name;
    this.pi.setSessionName(name);
  }

  private async applyTmux(name: string): Promise<void> {
    const env = this.getEnv();
    if (!env.TMUX || !env.TMUX_PANE) return;
    const current = this.state("tmuxWindow").lastApplied
      ? await this.exec("tmux", ["display-message", "-p", "-t", env.TMUX_PANE, "#{window_name}"], 3000)
      : undefined;
    if (!this.shouldApply("tmuxWindow", current)) return;
    await this.renamed("tmuxWindow", "tmux", ["rename-window", "-t", env.TMUX_PANE, name], 3000);
  }

  private async herdrIds(): Promise<{ paneId: string; tabId?: string } | undefined> {
    const env = this.getEnv();
    if (env.HERDR_PANE_ID) {
      return { paneId: env.HERDR_PANE_ID, ...(env.HERDR_TAB_ID ? { tabId: env.HERDR_TAB_ID } : {}) };
    }
    if (!env.HERDR_ENV) return undefined;
    const output = await this.exec("herdr", ["pane", "current"], 5000);
    const pane = output
      ? parseJson<{ result?: { pane?: { pane_id?: string; tab_id?: string } } }>(output)?.result?.pane
      : undefined;
    return pane?.pane_id ? { paneId: pane.pane_id, ...(pane.tab_id ? { tabId: pane.tab_id } : {}) } : undefined;
  }

  private async herdrPaneInfo(paneId: string): Promise<{ label?: string } | undefined> {
    const output = await this.exec("herdr", ["pane", "get", paneId], 5000);
    if (!output) return undefined;
    const pane = parseJson<{ pane?: { label?: string; pane_label?: string; manual_label?: string } }>(output)?.pane;
    const label = pane?.label ?? pane?.pane_label ?? pane?.manual_label;
    return label === undefined ? {} : { label };
  }

  private async herdrTabInfo(tabId: string): Promise<{ label?: string } | undefined> {
    const output = await this.exec("herdr", ["tab", "get", tabId], 5000);
    if (!output) return undefined;
    const label = parseJson<{ tab?: { label?: string } }>(output)?.tab?.label;
    return label === undefined ? {} : { label };
  }

  private async applyHerdrPane(name: string): Promise<void> {
    const ids = await this.herdrIds();
    if (!ids) return;
    const state = this.state("herdrPane");
    const current = state.lastApplied ? (await this.herdrPaneInfo(ids.paneId))?.label : undefined;
    if (!this.shouldApply("herdrPane", current)) return;
    await this.renamed("herdrPane", "herdr", ["pane", "rename", ids.paneId, name], 5000);
  }

  private async applyHerdrTab(name: string): Promise<void> {
    const ids = await this.herdrIds();
    let tabId = ids?.tabId;
    if (!tabId && ids) {
      const output = await this.exec("herdr", ["pane", "get", ids.paneId], 5000);
      tabId = output ? parseJson<{ pane?: { tab_id?: string } }>(output)?.pane?.tab_id : undefined;
    }
    if (!tabId) return;
    const state = this.state("herdrTab");
    const current = state.lastApplied ? (await this.herdrTabInfo(tabId))?.label : undefined;
    if (!this.shouldApply("herdrTab", current)) return;
    await this.renamed("herdrTab", "herdr", ["tab", "rename", tabId, name], 5000);
  }

  private async zellijPane(): Promise<{ id: number; title?: string; tab_id?: number; tab_name?: string } | undefined> {
    const env = this.getEnv();
    if (!env.ZELLIJ || !env.ZELLIJ_PANE_ID) return undefined;
    const output = await this.exec("zellij", ["action", "list-panes", "-j", "-t"], 5000);
    const panes = output
      ? parseJson<Array<{ id: number; title?: string; tab_id?: number; tab_name?: string }>>(output)
      : undefined;
    const paneId = Number(env.ZELLIJ_PANE_ID);
    return panes?.find((pane) => pane.id === paneId);
  }

  private async applyZellijPane(name: string): Promise<void> {
    const env = this.getEnv();
    if (!env.ZELLIJ || !env.ZELLIJ_PANE_ID) return;
    const state = this.state("zellijPane");
    const pane = state.lastApplied ? await this.zellijPane() : undefined;
    if (!this.shouldApply("zellijPane", pane?.title)) return;
    await this.renamed(
      "zellijPane",
      "zellij",
      ["action", "rename-pane", "-p", env.ZELLIJ_PANE_ID, name],
      5000
    );
  }

  private async applyZellijTab(name: string): Promise<void> {
    const env = this.getEnv();
    if (!env.ZELLIJ || !env.ZELLIJ_PANE_ID) return;
    const pane = await this.zellijPane();
    if (pane?.tab_id === undefined) return;
    const state = this.state("zellijTab");
    if (!this.shouldApply("zellijTab", state.lastApplied ? pane.tab_name : undefined)) return;
    await this.renamed(
      "zellijTab",
      "zellij",
      ["action", "rename-tab", "-t", String(pane.tab_id), name],
      5000
    );
  }
}
