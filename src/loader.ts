import type { LoaderConfig, LoaderPreset } from "./types.js";

export const LOADER_PRESETS: Readonly<Record<LoaderPreset, readonly string[]>> = {
  braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  dots: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
  line: ["-", "\\", "|", "/"],
  bounce: ["⠁", "⠂", "⠄", "⠂"],
  pulse: ["·", "•", "●", "•"],
  none: []
};

export function loaderFrames(config: LoaderConfig): readonly string[] {
  return config.frames.length > 0 ? config.frames : LOADER_PRESETS[config.preset];
}
