import { describe, expect, it } from "vitest";
import { EventJournal } from "./event-journal.js";

describe("EventJournal", () => {
  it("assigns monotonic sequences and resumes after a cursor", () => {
    const journal = new EventJournal();
    journal.append({ type: "one", data: 1 });
    journal.append({ type: "two", data: 2 });
    expect(journal.after(1)?.map((event) => event.sequence)).toEqual([2]);
  });

  it("requires a snapshot after retained history has expired", () => {
    const journal = new EventJournal(2);
    journal.append({ type: "one", data: 1 });
    journal.append({ type: "two", data: 2 });
    journal.append({ type: "three", data: 3 });
    expect(journal.after(0)).toBeNull();
  });

  it("requires a snapshot when the client cursor is ahead after a server restart", () => {
    const journal = new EventJournal();
    journal.append({ type: "fresh-server", data: 1 });
    expect(journal.after(20)).toBeNull();
  });
});
