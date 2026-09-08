import { describe, expect, it } from "vitest";
import { loaderFrames, LOADER_PRESETS } from "../src/loader.js";

const base = { preset: "braille" as const, frames: [], intervalMs: 75 };

describe("loader frames", () => {
  it("provides every documented preset", () => {
    expect(Object.keys(LOADER_PRESETS)).toEqual(["braille", "dots", "line", "bounce", "pulse", "none"]);
    expect(loaderFrames(base)).toBe(LOADER_PRESETS.braille);
    expect(LOADER_PRESETS.none).toEqual([]);
  });

  it("prefers custom frames", () => {
    expect(loaderFrames({ ...base, frames: ["a", "b"] })).toEqual(["a", "b"]);
  });
});
