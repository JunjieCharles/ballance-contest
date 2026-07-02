import type { StageConfig } from "@ballance/contracts";
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
});
