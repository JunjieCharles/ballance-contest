import type { StageConfig } from "@ballance/contracts";
import type { AutomationSnapshot } from "@ballance/core";
import { describe, expect, it } from "vitest";
import { CompetitionAuditService } from "./competition-audit-service.js";
import { EventJournal } from "./event-journal.js";
import { ScoreboardService } from "./scoreboard-service.js";

const stages: StageConfig[] = [
  { id: "s1", order: 1, label: "SR1", level: 1, mode: "SR", mapKind: "official", timeLimitMs: 60_000, scoring: [20], minimumScoringPlace: 1 },
  { id: "s2", order: 2, label: "SR2", level: 2, mode: "SR", mapKind: "official", timeLimitMs: 60_000, scoring: [20], minimumScoringPlace: 1 }
];

describe("extracted runtime services", () => {
  it("keeps score editing policy inside ScoreboardService", () => {
    const service = new ScoreboardService();
    expect(service.editPermissions(stages, "published", "s2")).toEqual([
      { stageId: "s1", editable: true },
      { stageId: "s2", editable: false, reason: expect.stringContaining("下一关 Ready") }
    ]);
    expect(service.editPermissions(stages, "finished", "s1").every((permission) => permission.editable)).toBe(true);
    expect(() => service.assertEditAllowed(service.editPermissions(stages, "published", "s1"), "s1"))
      .toThrowError(/下一关 Ready/);
  });

  it("keeps in-memory logs and attention isolated by competition", () => {
    const journal = new EventJournal();
    const audit = new CompetitionAuditService(undefined, journal, () => undefined);
    audit.appendRawLog("competition-a", "mock-client", "line-a");
    audit.appendRawLog("competition-b", "test-referee", "line-b");
    audit.appendAttention("competition-a", {
      id: "attention-a",
      category: "flow",
      severity: "info",
      title: "A",
      message: "message-a",
      occurredAt: new Date().toISOString()
    });

    expect(audit.rawClientLogs("competition-a", 10).map((line) => line.rawLine)).toEqual(["line-a"]);
    expect(audit.attentionItems("competition-a")).toEqual([expect.objectContaining({ id: "attention-a" })]);
    expect(audit.attentionItems("competition-b")).toEqual([]);

    audit.removeCompetition("competition-a");
    expect(audit.rawClientLogs("competition-a", 10)).toEqual([]);
    expect(audit.attentionItems("competition-a")).toEqual([]);
  });

  it("keeps resolved start-protection time stable and orders it with later events", () => {
    const journal = new EventJournal();
    const audit = new CompetitionAuditService(undefined, journal, () => undefined);
    const wallClockOriginMs = Date.UTC(2026, 6, 3, 1, 45, 0);
    const protectionOccurredAt = new Date(wallClockOriginMs + 60_000).toISOString();
    const laterOccurredAt = new Date(wallClockOriginMs + 120_000).toISOString();
    const snapshot: AutomationSnapshot = {
      phase: "restart-preparing",
      stateVersion: 1,
      automationEnabled: false,
      wallClockOriginMs,
      currentStageId: "s1",
      blockers: [],
      waitingParticipants: [],
      attempts: [],
      incidents: [{
        id: "protected-crash-1",
        type: "protected-crash",
        severity: "high",
        createdAtMs: 60_000,
        participantIds: ["JunjieCharles"],
        recommendedRestart: false,
        status: "resolved",
        evidence: "起跑敏感期掉线：JunjieCharles"
      }],
      rejectedResults: [],
      actions: []
    };
    audit.appendAttention("competition-a", {
      id: "second-stage-ready",
      category: "flow",
      severity: "info",
      title: "第二关 Ready",
      message: "SR2",
      occurredAt: laterOccurredAt,
      stageId: "s2"
    });

    const first = audit.attentionItems("competition-a", snapshot);
    const second = audit.attentionItems("competition-a", { ...snapshot, clockNowMs: 300_000 });
    expect(first.map((item) => item.id)).toEqual(["second-stage-ready", "incident:protected-crash-1"]);
    expect(first[1]).toMatchObject({ title: "起跑保护已自动执行", occurredAt: protectionOccurredAt });
    expect(second[1]?.occurredAt).toBe(protectionOccurredAt);
  });
});
