import { Type, type Static } from "@sinclair/typebox";

export const CompetitionModeSchema = Type.Union([
  Type.Literal("work"),
  Type.Literal("test")
]);
export type CompetitionMode = Static<typeof CompetitionModeSchema>;

export const TestInputKindSchema = Type.Union([
  Type.Literal("simulation"),
  Type.Literal("static-log"),
  Type.Literal("growing-log")
]);
export type TestInputKind = Static<typeof TestInputKindSchema>;

export const CapabilitiesSchema = Type.Object({
  realProcess: Type.Boolean(),
  network: Type.Boolean(),
  realCommands: Type.Boolean(),
  automation: Type.Boolean(),
  virtualClock: Type.Boolean(),
  playback: Type.Boolean(),
  faultInjection: Type.Boolean()
});
export type Capabilities = Static<typeof CapabilitiesSchema>;

export const capabilitiesFor = (mode: CompetitionMode): Capabilities =>
  mode === "work"
    ? {
        realProcess: true,
        network: true,
        realCommands: true,
        automation: true,
        virtualClock: false,
        playback: false,
        faultInjection: false
      }
    : {
        realProcess: false,
        network: false,
        realCommands: false,
        automation: true,
        virtualClock: true,
        playback: true,
        faultInjection: true
      };

export const HealthResponseSchema = Type.Object({
  status: Type.Literal("ok"),
  version: Type.String(),
  now: Type.String(),
  modes: Type.Array(CompetitionModeSchema)
});
export type HealthResponse = Static<typeof HealthResponseSchema>;
