export type LabRealtimeSettings = {
  model: "gpt-realtime-2" | "gpt-realtime-2.1";
  voice:
    | "alloy"
    | "ash"
    | "ballad"
    | "coral"
    | "echo"
    | "sage"
    | "shimmer"
    | "verse"
    | "marin"
    | "cedar";
  speed: number;
  inputNoiseReduction: "off" | "near_field" | "far_field";
  semanticVadEagerness: "low" | "medium" | "high";
  maxOutputTokens: number | "inf";
  truncation: "auto" | "disabled";
};
