export type StatusState = "idle" | "working" | "asking" | "done";

export type LoaderPreset = "braille" | "dots" | "line" | "bounce" | "pulse" | "none";

export type TemplateVariableName =
  | "state"
  | "loader"
  | "statusIcon"
  | "indicator"
  | "description";

export type TemplateVariables = Record<TemplateVariableName, string>;

export interface LoaderConfig {
  preset: LoaderPreset;
  /** Non-empty custom frames override preset. */
  frames: string[];
  intervalMs: number;
}

export interface StatusIconsConfig {
  idle: string;
  working: string;
  asking: string;
  done: string;
}

export interface DescriptionConfig {
  wordCount: number;
  model: string;
  /** Zero means generate once. */
  refreshEveryPrompts: number;
}

export interface TabStatusConfig {
  enabled: boolean;
  titleTemplate: string;
  titleMaxLength: number;
  shutdownTitle: string;
  loader: LoaderConfig;
  icons: StatusIconsConfig;
  description: DescriptionConfig;
}

export interface ConfigLoadResult {
  config: TabStatusConfig;
  globalPath: string;
  projectPath: string;
  warnings: string[];
}
