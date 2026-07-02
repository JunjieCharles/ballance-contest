import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertScenarioDefinition,
  type ScenarioDefinition,
  type ScenarioFaultPlan,
  type ScenarioPlayerProfile
} from "@ballance/contracts";

const builtinScenario = (): ScenarioDefinition => ({
  schemaVersion: 1,
  id: "three-stage-main",
  name: "三轮混合模式主回归",
  year: 2026,
  timezone: "Asia/Shanghai",
  refereeConnectionId: "ref-1",
  players: [
    { id: "p1", displayName: "Alpha", connectionId: "101", profile: "expert" },
    { id: "p2", displayName: "Beta", connectionId: "102", profile: "normal" },
    { id: "p3", displayName: "Gamma", connectionId: "103", profile: "normal" },
    { id: "p4", displayName: "Delta", connectionId: "104", profile: "struggler" },
    { id: "p5", displayName: "测试选手", connectionId: "105", profile: "disruptor" }
  ],
  stages: [
    { id: "s1", order: 1, level: 1, mode: "SR", timeLimitMs: 600_000, scoring: [20, 15, 12], minimumScoringPlace: 3 },
    { id: "s2", order: 2, level: 2, mode: "HS", timeLimitMs: 600_000, scoring: [20, 15, 12], minimumScoringPlace: 3 },
    { id: "s3", order: 3, level: 13, mode: "SR", timeLimitMs: 900_000, scoring: [20, 15, 12], minimumScoringPlace: 3 }
  ],
  events: [
    { atMs: 0, sourceId: "login-1", type: "login", playerId: "p1", connectionId: "101" },
    { atMs: 0, sourceId: "login-2", type: "login", playerId: "p2", connectionId: "102" },
    { atMs: 0, sourceId: "login-3", type: "login", playerId: "p3", connectionId: "103" },
    { atMs: 0, sourceId: "login-4", type: "login", playerId: "p4", connectionId: "104" },
    { atMs: 0, sourceId: "login-5", type: "login", playerId: "p5", connectionId: "105" },
    { atMs: 500, sourceId: "practice-finish", type: "finish", stageId: "s1", playerId: "p2", score: 500, elapsedMs: 50_000 },
    { atMs: 900, sourceId: "ready-1", type: "ready", stageId: "s1", refereeConnectionId: "ref-1" },
    { atMs: 1_000, sourceId: "go-1", type: "go", stageId: "s1", refereeConnectionId: "ref-1" },
    { atMs: 2_000, sourceId: "s1-f1", type: "finish", stageId: "s1", playerId: "p1", score: 1_000, elapsedMs: 1_000 },
    { atMs: 2_200, sourceId: "s1-f2", type: "finish", stageId: "s1", playerId: "p2", score: 900, elapsedMs: 1_200 },
    { atMs: 2_400, sourceId: "s1-f3", type: "finish", stageId: "s1", playerId: "p3", score: 800, elapsedMs: 1_400 },
    { atMs: 2_600, sourceId: "s1-f4", type: "finish", stageId: "s1", playerId: "p4", score: 700, elapsedMs: 1_600 },
    { atMs: 2_800, sourceId: "s1-d5", type: "dnf", stageId: "s1", playerId: "p5", reason: "timeout" },
    { atMs: 4_000, sourceId: "go-2", type: "go", stageId: "s2", refereeConnectionId: "ref-1" },
    { atMs: 5_000, sourceId: "s2-f2", type: "finish", stageId: "s2", playerId: "p2", score: 1_800, elapsedMs: 1_000 },
    { atMs: 5_100, sourceId: "s2-f1", type: "finish", stageId: "s2", playerId: "p1", score: 2_000, elapsedMs: 1_100 },
    { atMs: 5_200, sourceId: "s2-f3", type: "finish", stageId: "s2", playerId: "p3", score: 1_800, elapsedMs: 1_200 },
    { atMs: 5_300, sourceId: "s2-f4", type: "finish", stageId: "s2", playerId: "p4", score: 1_500, elapsedMs: 1_300 },
    { atMs: 5_400, sourceId: "s2-d5", type: "dnf", stageId: "s2", playerId: "p5", reason: "warning" },
    { atMs: 7_000, sourceId: "go-3", type: "go", stageId: "s3", refereeConnectionId: "ref-1" },
    { atMs: 8_000, sourceId: "s3-f3", type: "finish", stageId: "s3", playerId: "p3", score: 1_000, elapsedMs: 1_000 },
    { atMs: 8_200, sourceId: "s3-f1", type: "finish", stageId: "s3", playerId: "p1", score: 900, elapsedMs: 1_200 },
    { atMs: 8_400, sourceId: "s3-f4", type: "finish", stageId: "s3", playerId: "p4", score: 800, elapsedMs: 1_400 },
    { atMs: 8_600, sourceId: "s3-f2", type: "finish", stageId: "s3", playerId: "p2", score: 700, elapsedMs: 1_600 },
    { atMs: 8_800, sourceId: "s3-d5", type: "dnf", stageId: "s3", playerId: "p5", reason: "timeout" }
  ],
  expected: { attempts: 3, scoreboardVersions: 15 }
});

const builtinBehaviorScenario = (
  id: string,
  name: string,
  randomSeed: number,
  profiles: readonly ScenarioPlayerProfile[],
  faultPlan: readonly ScenarioFaultPlan[] = []
): ScenarioDefinition => ({
  schemaVersion: 1,
  kind: "player-behavior",
  randomSeed,
  id,
  name,
  year: 2026,
  timezone: "Asia/Shanghai",
  refereeConnectionId: `${id}-referee`,
  players: profiles.map((profile, index) => ({
    id: `${id}-p${index + 1}`,
    displayName: `${({ normal: "普通玩家", expert: "游戏高手", struggler: "游戏低手", disruptor: "捣乱分子" } as const)[profile]} ${index + 1}`,
    connectionId: String(300 + index),
    profile
  })),
  stages: [],
  events: [],
  ...(faultPlan.length === 0 ? {} : { faultPlan: [...faultPlan] }),
  expected: { attempts: 0, scoreboardVersions: 0 }
});

const builtinBehaviorScenarios = (): ScenarioDefinition[] => [
  builtinBehaviorScenario("independent-player-sandbox", "20 人小型综合沙盒", 20_260_631, [
    ...Array.from({ length: 8 }, () => "normal" as const),
    ...Array.from({ length: 6 }, () => "expert" as const),
    ...Array.from({ length: 3 }, () => "struggler" as const),
    ...Array.from({ length: 3 }, () => "disruptor" as const)
  ], [
    { id: "small-reconnect", fault: "participant-disconnect", trigger: "running", stageOrder: 1, offsetMs: 35_000, playerId: "independent-player-sandbox-p2", recoverAfterMs: 8_000 },
    { id: "small-warning", fault: "warning", trigger: "running", stageOrder: 1, offsetMs: 50_000, playerId: "independent-player-sandbox-p19", message: "just pressed the Reset hotkey" }
  ]),
  builtinBehaviorScenario("large-player-sandbox", "30 人大型综合沙盒", 20_260_701, [
    ...Array.from({ length: 12 }, () => "normal" as const),
    ...Array.from({ length: 8 }, () => "expert" as const),
    ...Array.from({ length: 6 }, () => "struggler" as const),
    ...Array.from({ length: 4 }, () => "disruptor" as const)
  ], [
    { id: "large-reconnect", fault: "participant-disconnect", trigger: "running", stageOrder: 1, offsetMs: 30_000, playerId: "large-player-sandbox-p3", recoverAfterMs: 10_000 },
    { id: "large-warning", fault: "warning", trigger: "running", stageOrder: 2, offsetMs: 45_000, playerId: "large-player-sandbox-p27", message: "just restarted while uncontrollable" }
  ]),
  builtinBehaviorScenario("normal-player-roster", "普通玩家场景", 10_001, Array.from({ length: 15 }, () => "normal")),
  builtinBehaviorScenario("expert-player-roster", "高手竞速场景", 20_003, [
    ...Array.from({ length: 12 }, () => "expert" as const),
    ...Array.from({ length: 3 }, () => "normal" as const)
  ]),
  builtinBehaviorScenario("timeout-player-roster", "低手超时与 DNF 场景", 30_007, [
    ...Array.from({ length: 10 }, () => "normal" as const),
    ...Array.from({ length: 5 }, () => "struggler" as const)
  ]),
  builtinBehaviorScenario("disruptor-player-roster", "捣乱与违规场景", 40_009, [
    ...Array.from({ length: 12 }, () => "normal" as const),
    ...Array.from({ length: 3 }, () => "disruptor" as const)
  ]),
  builtinBehaviorScenario("protected-crash-fault", "保护期崩溃故障场景", 50_011, Array.from({ length: 15 }, () => "normal" as const), [
    { id: "protected-crash", fault: "player-crash", trigger: "running", stageOrder: 1, offsetMs: 5_000, playerId: "protected-crash-fault-p1" }
  ]),
  builtinBehaviorScenario("server-disconnect-fault", "服务器断线故障场景", 50_013, Array.from({ length: 15 }, () => "normal" as const), [
    { id: "server-disconnect", fault: "server-disconnect", trigger: "running", stageOrder: 1, offsetMs: 20_000 }
  ]),
  builtinBehaviorScenario("mock-client-exit-fault", "MockClient 退出故障场景", 50_017, Array.from({ length: 15 }, () => "normal" as const), [
    { id: "mock-client-exit", fault: "process-exit", trigger: "ready", stageOrder: 1, offsetMs: 4_000 }
  ]),
  builtinBehaviorScenario("clock-jump-fault", "时钟跳变故障场景", 50_021, Array.from({ length: 15 }, () => "normal" as const), [
    { id: "clock-jump", fault: "clock-jump", trigger: "running", stageOrder: 1, offsetMs: 30_000 }
  ])
];

export const loadScenarioDefinitions = (): ScenarioDefinition[] => {
  const loaded: ScenarioDefinition[] = [];
  const root = resolve(process.cwd(), "test", "fixtures", "scenarios");
  if (existsSync(root)) {
    for (const directory of readdirSync(root, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const file = join(root, directory.name, "scenario.json");
      if (!existsSync(file)) continue;
      try {
        loaded.push(assertScenarioDefinition(JSON.parse(readFileSync(file, "utf8")) as unknown));
      } catch {
        // Invalid fixture files are ignored here; fixture tests validate them directly.
      }
    }
  }
  if (!loaded.some((scenario) => scenario.id === "three-stage-main")) loaded.push(builtinScenario());
  for (const scenario of builtinBehaviorScenarios()) {
    if (!loaded.some((candidate) => candidate.id === scenario.id)) loaded.push(scenario);
  }
  return loaded.sort((left, right) => left.name.localeCompare(right.name));
};
