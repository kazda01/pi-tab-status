import { describe, expect, it, vi } from "vitest";

const { completeSimple } = vi.hoisted(() => ({ completeSimple: vi.fn() }));
vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
  return { ...actual, completeSimple };
});

import {
  buildDescriptionInput,
  generateDescription,
  normalizeDescription,
  userPrompts
} from "../src/description.js";

function context() {
  const configured = { provider: "google", id: "gemini-2.5-flash" };
  const active = { provider: "openai-codex", id: "mini" };
  const getApiKeyAndHeaders = vi.fn<() => Promise<any>>(async () => ({ ok: true, apiKey: "key" }));
  return {
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "user", content: "first" } },
        { type: "message", message: { role: "assistant", content: [] } },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "latest" }] } }
      ]
    },
    modelRegistry: {
      find: vi.fn(() => configured),
      getApiKeyAndHeaders
    },
    model: active,
    configured,
    active
  };
}

const config = { wordCount: 2, model: "google/gemini-2.5-flash", refreshEveryPrompts: 3 };

describe("description generation", () => {
  it("normalizes Unicode words and input prompts", () => {
    expect(normalizeDescription("\"Hello, café world!\"", 2)).toBe("Hello café");
    expect(normalizeDescription("---", 2)).toBeUndefined();
    const ctx = context();
    expect(userPrompts(ctx as never)).toEqual(["first", "latest"]);
    expect(buildDescriptionInput("current", ctx as never)).toContain("Prompt 3: current");
    expect(buildDescriptionInput("latest", ctx as never)).not.toContain("Prompt 3");
  });

  it("uses configured model and returns a bounded description", async () => {
    completeSimple.mockResolvedValueOnce({
      stopReason: "stop",
      content: [{ type: "text", text: "Fix all tests now" }]
    });
    const ctx = context();
    const result = await generateDescription("task", ctx as never, config);
    expect(result.description).toBe("Fix all");
    expect(result.attemptedModels).toEqual(["google/gemini-2.5-flash"]);
    expect(completeSimple).toHaveBeenCalledWith(
      ctx.configured,
      expect.objectContaining({ messages: [expect.objectContaining({ content: expect.stringContaining("task") })] }),
      expect.objectContaining({ reasoning: "minimal", cacheRetention: "none" })
    );
  });

  it("passes provider headers, environment, and cancellation signal", async () => {
    const ctx = context();
    ctx.modelRegistry.getApiKeyAndHeaders.mockResolvedValueOnce({
      ok: true,
      headers: { "x-provider": "configured" },
      env: { PROVIDER_REGION: "local" }
    });
    completeSimple.mockResolvedValueOnce({
      stopReason: "length",
      content: [{ type: "text", text: "Short title" }]
    });
    const controller = new AbortController();
    const result = await generateDescription("task", ctx as never, config, controller.signal);
    expect(result.description).toBe("Short title");
    expect(completeSimple).toHaveBeenCalledWith(
      ctx.configured,
      expect.anything(),
      expect.objectContaining({
        headers: { "x-provider": "configured" },
        env: { PROVIDER_REGION: "local" },
        signal: controller.signal
      })
    );
  });

  it("throws on missing auth without falling back to the active model", async () => {
    const ctx = context();
    ctx.modelRegistry.getApiKeyAndHeaders.mockResolvedValueOnce({ ok: false, error: "no auth" });
    await expect(generateDescription("task", ctx as never, config)).rejects.toThrow(
      'Description model "google/gemini-2.5-flash" is not authenticated: no auth'
    );
    expect(ctx.modelRegistry.find).toHaveBeenCalledTimes(1);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("propagates generation errors and handles empty input and cancellation", async () => {
    const ctx = context();
    completeSimple.mockRejectedValueOnce(new Error("network"));
    await expect(generateDescription("task", ctx as never, config)).rejects.toThrow("network");

    ctx.sessionManager.getBranch = () => [];
    expect(await generateDescription("", ctx as never, config)).toEqual({ attemptedModels: [] });

    const controller = new AbortController();
    controller.abort();
    expect(await generateDescription("task", context() as never, config, controller.signal)).toEqual({ attemptedModels: [] });
  });

  it("throws when the configured model is unavailable instead of using the active model", async () => {
    const ctx = context();
    ctx.modelRegistry.find.mockReturnValue(undefined as any);
    await expect(generateDescription("task", ctx as never, config)).rejects.toThrow(
      'Description model "google/gemini-2.5-flash" is not available in Pi'
    );
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("throws for bad responses, missing configuration, and malformed model keys", async () => {
    const ctx = context();
    completeSimple.mockResolvedValueOnce({ stopReason: "error", content: [] });
    await expect(generateDescription("task", ctx as never, config)).rejects.toThrow("stopped with error");

    completeSimple.mockResolvedValueOnce({ stopReason: "stop", content: [{ type: "thinking", thinking: "none" }] });
    await expect(generateDescription("task", ctx as never, config)).rejects.toThrow("returned no usable text");

    await expect(generateDescription("task", ctx as never, { ...config, model: "" })).rejects.toThrow(
      "No description model is configured"
    );
    await expect(generateDescription("task", ctx as never, { ...config, model: "invalid" })).rejects.toThrow(
      "must use provider/modelId"
    );
  });
});
