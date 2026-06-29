import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

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

export const StageModeSchema = Type.Union([Type.Literal("SR"), Type.Literal("HS")]);
export type StageMode = Static<typeof StageModeSchema>;

export const ScenarioPlayerSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  displayName: Type.String({ minLength: 1 }),
  connectionId: Type.String({ minLength: 1 })
});

export const ScenarioStageSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  order: Type.Integer({ minimum: 1 }),
  level: Type.Integer({ minimum: 0, maximum: 13 }),
  mode: StageModeSchema,
  timeLimitMs: Type.Integer({ minimum: 1 }),
  scoring: Type.Array(Type.Number(), { minItems: 1 }),
  minimumScoringPlace: Type.Integer({ minimum: 1 })
});
export type ScenarioStage = Static<typeof ScenarioStageSchema>;

const ScenarioEventBase = {
  atMs: Type.Integer({ minimum: 0 }),
  sourceId: Type.String({ minLength: 1 })
};

export const ScenarioEventSchema = Type.Union([
  Type.Object({ ...ScenarioEventBase, type: Type.Literal("login"), playerId: Type.String(), connectionId: Type.String() }),
  Type.Object({ ...ScenarioEventBase, type: Type.Literal("disconnect"), playerId: Type.String(), connectionId: Type.String() }),
  Type.Object({ ...ScenarioEventBase, type: Type.Literal("ready"), stageId: Type.String(), refereeConnectionId: Type.String() }),
  Type.Object({ ...ScenarioEventBase, type: Type.Literal("go"), stageId: Type.String(), refereeConnectionId: Type.String() }),
  Type.Object({ ...ScenarioEventBase, type: Type.Literal("finish"), stageId: Type.String(), playerId: Type.String(), score: Type.Number(), elapsedMs: Type.Integer({ minimum: 0 }) }),
  Type.Object({ ...ScenarioEventBase, type: Type.Literal("dnf"), stageId: Type.String(), playerId: Type.String(), reason: Type.String() }),
  Type.Object({ ...ScenarioEventBase, type: Type.Literal("cheat"), playerId: Type.String(), enabled: Type.Boolean() }),
  Type.Object({ ...ScenarioEventBase, type: Type.Literal("warning"), playerId: Type.Optional(Type.String()), message: Type.String() }),
  Type.Object({
    ...ScenarioEventBase,
    type: Type.Literal("fault"),
    fault: Type.Union([
      Type.Literal("process-exit"), Type.Literal("server-disconnect"), Type.Literal("clock-jump"),
      Type.Literal("participant-disconnect"), Type.Literal("player-crash")
    ]),
    playerId: Type.Optional(Type.String()),
    milliseconds: Type.Optional(Type.Integer({ minimum: 0 }))
  })
]);
export type ScenarioEvent = Static<typeof ScenarioEventSchema>;

export const ScenarioDefinitionSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  year: Type.Integer({ minimum: 2000, maximum: 9999 }),
  timezone: Type.String({ minLength: 1 }),
  refereeConnectionId: Type.String({ minLength: 1 }),
  players: Type.Array(ScenarioPlayerSchema, { minItems: 1 }),
  stages: Type.Array(ScenarioStageSchema, { minItems: 1 }),
  events: Type.Array(ScenarioEventSchema),
  expected: Type.Object({
    attempts: Type.Integer({ minimum: 0 }),
    scoreboardVersions: Type.Integer({ minimum: 0 })
  })
});
export type ScenarioDefinition = Static<typeof ScenarioDefinitionSchema>;

export const assertScenarioDefinition = (value: unknown): ScenarioDefinition => {
  if (!Value.Check(ScenarioDefinitionSchema, value)) {
    const first = [...Value.Errors(ScenarioDefinitionSchema, value)][0];
    throw new TypeError(`Invalid scenario at ${first?.path ?? "/"}: ${first?.message ?? "unknown error"}`);
  }
  return value;
};
