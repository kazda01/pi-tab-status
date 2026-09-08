import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { generateDescription, normalizeDescription, userPrompts } from "./description.js";
import { registerExtensionSettings } from "./extension-settings.js";
import { loaderFrames } from "./loader.js";
import { SurfaceManager, type SurfaceOwnershipSnapshot } from "./surfaces.js";
import {
  compileTemplate,
  renderTemplate,
  safeTitle,
  templateUses,
  type CompiledTemplate
} from "./template.js";
import type {
  ConfigLoadResult,
  StatusState,
  TabStatusConfig,
  TemplateVariables
} from "./types.js";

export type {
  ConfigLoadResult,
  DescriptionConfig,
  LoaderConfig,
  LoaderPreset,
  StatusIconsConfig,
  StatusState,
  TabStatusConfig,
  TemplateVariableName,
  TemplateVariables
} from "./types.js";
export { DEFAULT_CONFIG, compileTemplate, renderTemplate };

export const ENTRY_TYPE = "pi-tab-status";
export const LEGACY_ENTRY_TYPE = "tab-status-description";
const QUESTION_TOOLS = new Set(["ask_user_question", "plan_mode_question"]);

interface PersistedState {
  version: 1;
  description: string;
  descriptionPromptCount: number;
  surfaces?: SurfaceOwnershipSnapshot;
}

interface RestoredState {
  description?: string;
  descriptionPromptCount: number;
  surfaces: SurfaceOwnershipSnapshot;
}

function restoreState(ctx: ExtensionContext, wordCount: number): RestoredState {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom") continue;
    if (entry.customType === ENTRY_TYPE) {
      const data = entry.data as Partial<PersistedState> | undefined;
      const description = typeof data?.description === "string"
        ? normalizeDescription(data.description, wordCount)
        : undefined;
      if (!description) continue;
      const storedPromptCount = data?.descriptionPromptCount;
      return {
        description,
        descriptionPromptCount: Number.isSafeInteger(storedPromptCount)
          ? Math.max(0, Number(storedPromptCount))
          : 0,
        surfaces: data?.surfaces ?? {}
      };
    }
    if (entry.customType === LEGACY_ENTRY_TYPE) {
      const data = entry.data as { description?: unknown; promptCount?: unknown } | undefined;
      const description = typeof data?.description === "string"
        ? normalizeDescription(data.description, wordCount)
        : undefined;
      if (!description) continue;
      const storedPromptCount = data?.promptCount;
      return {
        description,
        descriptionPromptCount: Number.isSafeInteger(storedPromptCount)
          ? Math.max(0, Number(storedPromptCount))
          : 0,
        surfaces: {}
      };
    }
  }
  return { descriptionPromptCount: 0, surfaces: {} };
}

export default function tabStatusExtension(pi: ExtensionAPI) {
  registerExtensionSettings(pi);
  let loaded: ConfigLoadResult = {
    config: {
      ...DEFAULT_CONFIG,
      loader: { ...DEFAULT_CONFIG.loader, frames: [...DEFAULT_CONFIG.loader.frames] },
      icons: { ...DEFAULT_CONFIG.icons },
      description: { ...DEFAULT_CONFIG.description }
    },
    globalPath: "",
    projectPath: "",
    warnings: []
  };
  let compiled: CompiledTemplate = compileTemplate(loaded.config.titleTemplate);
  let state: StatusState = "idle";
  let running = false;
  let frameIndex = 0;
  let animationId: ReturnType<typeof setInterval> | undefined;
  let lastTitle: string | undefined;
  let description: string | undefined;
  let descriptionPromptCount = 0;
  let promptCount = 0;
  let generationSequence = 0;
  let generationPromise: Promise<void> | undefined;
  let lastDescriptionError: string | undefined;
  let sessionController = new AbortController();
  let surfaces = new SurfaceManager(pi);
  const pendingQuestions = new Set<string>();

  const descriptionEnabled = (): boolean => templateUses(compiled, "description");

  const clearAnimation = (): void => {
    if (animationId === undefined) return;
    clearInterval(animationId);
    animationId = undefined;
  };

  const variables = (loader = ""): TemplateVariables => {
    const statusIcon = loaded.config.icons[state];
    return {
      state,
      loader: state === "working" ? loader : "",
      statusIcon,
      indicator: state === "working" ? loader || statusIcon : statusIcon,
      description: descriptionEnabled() ? description ?? "" : ""
    };
  };

  const renderedTitle = (loader = ""): string => safeTitle(
    renderTemplate(compiled, variables(loader)),
    loaded.config.titleMaxLength
  );

  const updateTitle = (ctx: ExtensionContext, title: string): void => {
    if (title === lastTitle) return;
    lastTitle = title;
    ctx.ui.setTitle(title);
  };

  const setTitle = (ctx: ExtensionContext, next: StatusState): void => {
    state = next;
    clearAnimation();
    if (!ctx.hasUI) return;
    if (!loaded.config.enabled) {
      updateTitle(ctx, safeTitle(loaded.config.shutdownTitle, loaded.config.titleMaxLength));
      return;
    }

    const frames = loaderFrames(loaded.config.loader);
    const frameTitles = frames.map((frame) => renderedTitle(frame));
    frameIndex = 0;
    updateTitle(ctx, frameTitles[0] ?? renderedTitle());
    if (next !== "working" || new Set(frameTitles).size < 2) return;

    animationId = setInterval(() => {
      if (!running || state !== "working") {
        clearAnimation();
        return;
      }
      frameIndex = (frameIndex + 1) % frameTitles.length;
      updateTitle(ctx, frameTitles[frameIndex] ?? renderedTitle());
    }, loaded.config.loader.intervalMs);
  };

  const persist = (): void => {
    if (!description) return;
    const data: PersistedState = {
      version: 1,
      description,
      descriptionPromptCount,
      surfaces: surfaces.snapshot()
    };
    pi.appendEntry(ENTRY_TYPE, data);
  };

  const invalidateGeneration = (): void => {
    generationSequence += 1;
    generationPromise = undefined;
  };

  const reloadConfig = async (ctx: ExtensionContext): Promise<void> => {
    const wasDescriptionEnabled = descriptionEnabled();
    const previousDescriptionModel = loaded.config.description.model;
    loaded = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
    compiled = compileTemplate(loaded.config.titleTemplate);
    if (loaded.config.description.model !== previousDescriptionModel) lastDescriptionError = undefined;
    if (wasDescriptionEnabled && !descriptionEnabled()) invalidateGeneration();
    if (loaded.warnings.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`pi-tab-status: ${loaded.warnings[0]}`, "warning");
    }
    setTitle(ctx, state);
  };

  const applyDescription = async (
    nextDescription: string,
    requestedAt: number,
    sequence: number,
    ctx: ExtensionContext
  ): Promise<boolean> => {
    if (sequence !== generationSequence || sessionController.signal.aborted || !descriptionEnabled()) return false;
    description = nextDescription;
    descriptionPromptCount = requestedAt;
    setTitle(ctx, state);
    await surfaces.apply(nextDescription);
    if (sequence !== generationSequence || sessionController.signal.aborted) return false;
    persist();
    return true;
  };

  const refreshDescription = async (
    prompt: string,
    ctx: ExtensionContext,
    options: { force?: boolean; signal?: AbortSignal } = {}
  ): Promise<boolean> => {
    if (!loaded.config.enabled || !descriptionEnabled()) return false;
    const interval = loaded.config.description.refreshEveryPrompts;
    if (
      !options.force &&
      description &&
      (interval === 0 || promptCount - descriptionPromptCount < interval)
    ) return false;
    if (generationPromise && !options.force) return false;

    const requestedAt = promptCount;
    const sequence = ++generationSequence;
    const signals = [sessionController.signal];
    if (ctx.signal) signals.push(ctx.signal);
    if (options.signal) signals.push(options.signal);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    let applied = false;
    const pending = (async () => {
      try {
        const result = await generateDescription(prompt, ctx, loaded.config.description, signal);
        lastDescriptionError = undefined;
        if (result.description) applied = await applyDescription(result.description, requestedAt, sequence, ctx);
      } catch (error) {
        if (signal?.aborted) return;
        const message = `pi-tab-status: ${error instanceof Error ? error.message : String(error)}`;
        if (options.force || message !== lastDescriptionError) ctx.ui.notify(message, "error");
        lastDescriptionError = message;
      }
    })();
    generationPromise = pending;
    await pending;
    if (generationPromise === pending) generationPromise = undefined;
    return applied;
  };

  const restoreFromBranch = (ctx: ExtensionContext): void => {
    const restored = restoreState(ctx, loaded.config.description.wordCount);
    description = restored.description;
    descriptionPromptCount = restored.descriptionPromptCount;
    promptCount = userPrompts(ctx).length;
    surfaces.restore(restored.surfaces);
  };

  pi.on("session_start", async (_event, ctx) => {
    sessionController.abort();
    sessionController = new AbortController();
    invalidateGeneration();
    running = false;
    pendingQuestions.clear();
    state = "idle";
    surfaces = new SurfaceManager(pi);
    registerExtensionSettings(pi);
    await reloadConfig(ctx);
    restoreFromBranch(ctx);
    setTitle(ctx, "idle");
    if (descriptionEnabled() && description) await surfaces.apply(description);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await reloadConfig(ctx);
    promptCount += 1;
    running = true;
    setTitle(ctx, "working");
    void refreshDescription(event.prompt, ctx).catch(() => undefined);
  });

  pi.on("agent_start", async (_event, ctx) => {
    running = true;
    setTitle(ctx, pendingQuestions.size > 0 ? "asking" : "working");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!QUESTION_TOOLS.has(event.toolName)) return;
    pendingQuestions.add(event.toolCallId);
    setTitle(ctx, "asking");
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!QUESTION_TOOLS.has(event.toolName)) return;
    pendingQuestions.delete(event.toolCallId);
    if (running) setTitle(ctx, pendingQuestions.size > 0 ? "asking" : "working");
  });

  pi.on("agent_settled", async (_event, ctx) => {
    running = false;
    pendingQuestions.clear();
    setTitle(ctx, "done");
  });

  pi.on("session_info_changed", async (event) => {
    surfaces.handleSessionInfoChanged(event.name);
  });

  pi.on("session_tree", async (_event, ctx) => {
    invalidateGeneration();
    restoreFromBranch(ctx);
    setTitle(ctx, state);
    if (descriptionEnabled() && description) await surfaces.apply(description);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    sessionController.abort();
    invalidateGeneration();
    running = false;
    pendingQuestions.clear();
    clearAnimation();
    if (ctx.hasUI) updateTitle(ctx, safeTitle(loaded.config.shutdownTitle, loaded.config.titleMaxLength));
  });

  pi.registerCommand("tab-status", {
    description: "Configure or inspect terminal tab status",
    getArgumentCompletions(prefix) {
      const options = ["status", "reload", "preview", "regenerate"]; 
      const items = options
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "status") {
        const detected = surfaces.detected().join(", ");
        const managed = surfaces.managed().join(", ");
        ctx.ui.notify(
          `pi-tab-status: ${state}; description ${descriptionEnabled() ? "on" : "off"}; ` +
          `model ${loaded.config.description.model}; value ${description ?? "(none)"}; ` +
          `detected ${detected}; managed ${managed}`,
          "info"
        );
        return;
      }
      if (action === "reload") {
        invalidateGeneration();
        await reloadConfig(ctx);
        restoreFromBranch(ctx);
        ctx.ui.notify(`Reloaded ${loaded.globalPath}`, "info");
        return;
      }
      if (action === "preview") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/tab-status preview requires TUI mode", "error");
          return;
        }
        const original = state;
        const frames = loaderFrames(loaded.config.loader);
        const previews = (["idle", "working", "asking", "done"] as StatusState[]).map((previewState) => {
          state = previewState;
          return `${previewState}: ${renderedTitle(frames[0] ?? "")}`;
        });
        state = original;
        ctx.ui.notify(previews.join("\n"), "info");
        return;
      }
      if (action === "regenerate") {
        if (!descriptionEnabled()) {
          ctx.ui.notify("Add {{description}} to titleTemplate to enable descriptions", "info");
          return;
        }
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/tab-status regenerate requires TUI mode", "error");
          return;
        }
        const prompt = userPrompts(ctx).at(-1) ?? "";
        if (!prompt) {
          ctx.ui.notify("No user prompt is available for description generation", "warning");
          return;
        }
        const controller = new AbortController();
        const applied = await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
          const loader = new BorderedLoader(tui, theme, "Generating tab description...");
          let finished = false;
          const finish = (value: boolean): void => {
            if (finished) return;
            finished = true;
            done(value);
          };
          loader.onAbort = () => {
            controller.abort();
            finish(false);
          };
          void refreshDescription(prompt, ctx, { force: true, signal: controller.signal })
            .then(finish)
            .catch(() => finish(false));
          return loader;
        });
        ctx.ui.notify(applied ? `Description: ${description}` : "Description was not changed", applied ? "info" : "warning");
        return;
      }
      ctx.ui.notify(`Unknown /tab-status action: ${action}`, "error");
    }
  });
}
