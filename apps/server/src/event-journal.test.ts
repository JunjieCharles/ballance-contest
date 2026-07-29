import { describe, expect, it, vi } from "vitest";
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

  it("publishes buffered events only after commit", () => {
    const journal = new EventJournal();
    const delivered: string[] = [];
    journal.subscribe((event) => delivered.push(event.type));
    const buffer = journal.beginBuffer();
    const first = journal.append({ type: "one", data: 1 });
    journal.append({ type: "two", data: 2 });

    expect(first.sequence).toBe(0);
    expect(journal.after(0)).toEqual([]);
    expect(delivered).toEqual([]);

    buffer.commit();
    expect(first.sequence).toBe(1);
    expect(journal.after(0)?.map((event) => event.type)).toEqual(["one", "two"]);
    expect(delivered).toEqual(["one", "two"]);
  });

  it("discards a rolled back nested buffer without consuming a sequence", () => {
    const journal = new EventJournal();
    const outer = journal.beginBuffer();
    journal.append({ type: "outer", data: 1 });
    const inner = journal.beginBuffer();
    journal.append({ type: "discarded", data: 2 });
    inner.rollback();
    outer.commit();

    expect(journal.after(0)?.map((event) => [event.sequence, event.type])).toEqual([[1, "outer"]]);
  });

  it("keeps a committed event durable when a listener throws", () => {
    const journal = new EventJournal();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    journal.subscribe(() => {
      throw new Error("listener failed after commit");
    });
    const buffer = journal.beginBuffer();
    journal.append({ type: "committed", data: 1 });

    expect(() => buffer.commit()).not.toThrow();
    expect(journal.after(0)?.map((event) => event.type)).toEqual(["committed"]);
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({ message: "listener failed after commit" }),
      { code: "EVENT_JOURNAL_LISTENER_FAILED" }
    );
    warning.mockRestore();
  });
});
