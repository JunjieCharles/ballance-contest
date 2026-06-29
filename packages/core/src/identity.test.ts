import { describe, expect, it } from "vitest";
import { ParticipantRegistry } from "./identity.js";

describe("ParticipantRegistry", () => {
  it("suggests a unique case-insensitive reconnect and keeps history after confirmation", () => {
    const registry = new ParticipantRegistry("competition-1");
    registry.addParticipant("PlayerOne", "p1");
    expect(registry.observeConnection("100", "playerone")).toEqual({ kind: "suggested", participantId: "p1" });
    registry.associate("100", "p1");
    registry.disconnect("100");
    registry.observeConnection("200", "PLAYERONE");
    const connection = registry.associate("200", "p1");
    expect(connection.historicalConnectionIds).toEqual(["100", "200"]);
  });

  it("reports duplicate-name conflicts and never auto-associates staff", () => {
    const registry = new ParticipantRegistry("competition-1");
    registry.addParticipant("same", "p1");
    registry.addParticipant("SAME", "p2");
    expect(registry.observeConnection("100", "Same")).toEqual({ kind: "conflict", candidateParticipantIds: ["p1", "p2"] });
    expect(registry.observeConnection("staff", "*Same")).toEqual({ kind: "unmatched" });
    expect(registry.getConnection("staff")?.role).toBe("staff");
  });

  it("supports audited merge/split primitives without losing the connection", () => {
    const registry = new ParticipantRegistry("competition-1");
    registry.addParticipant("Player", "p1");
    registry.observeConnection("100", "Player");
    registry.associate("100", "p1");
    registry.split("100");
    expect(registry.getConnection("100")).toMatchObject({ connectionId: "100", role: "unregistered" });
    expect(registry.getConnection("100")?.participantId).toBeUndefined();
  });
});
