export interface JournalEvent<T = unknown> {
  sequence: number;
  type: string;
  occurredAt: string;
  competitionId?: string;
  stateVersion?: number;
  data: T;
}

export interface JournalBuffer {
  commit(): void;
  rollback(): void;
}

export class EventJournal {
  private sequence = 0;
  private readonly events: JournalEvent[] = [];
  private readonly listeners = new Set<(event: JournalEvent) => void>();
  private readonly buffers: JournalEvent[][] = [];

  public constructor(private readonly capacity = 10_000) {}

  public append<T>(event: Omit<JournalEvent<T>, "sequence" | "occurredAt">): JournalEvent<T> {
    const recorded: JournalEvent<T> = { ...event, sequence: 0, occurredAt: new Date().toISOString() };
    const buffer = this.buffers.at(-1);
    if (buffer) buffer.push(recorded);
    else this.publish([recorded]);
    return recorded;
  }

  /**
   * Defer sequencing and listener delivery until the surrounding durable unit
   * of work commits. Nested buffers merge into their parent in LIFO order.
   */
  public beginBuffer(): JournalBuffer {
    const events: JournalEvent[] = [];
    this.buffers.push(events);
    let active = true;
    const close = (commit: boolean): void => {
      if (!active) return;
      if (this.buffers.at(-1) !== events) throw new Error("JOURNAL_BUFFER_ORDER_VIOLATION");
      active = false;
      this.buffers.pop();
      if (!commit || events.length === 0) return;
      const parent = this.buffers.at(-1);
      if (parent) parent.push(...events);
      else this.publish(events);
    };
    return {
      commit: () => close(true),
      rollback: () => close(false)
    };
  }

  public after(sequence: number): readonly JournalEvent[] | null {
    if (sequence > this.sequence) return null;
    const first = this.events[0]?.sequence ?? this.sequence + 1;
    if (sequence < first - 1) return null;
    return this.events.filter((event) => event.sequence > sequence);
  }

  public subscribe(listener: (event: JournalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(events: readonly JournalEvent[]): void {
    for (const event of events) {
      event.sequence = ++this.sequence;
      this.events.push(event);
    }
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    for (const event of events) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch (error) {
          process.emitWarning(
            error instanceof Error ? error : new Error(String(error)),
            { code: "EVENT_JOURNAL_LISTENER_FAILED" }
          );
        }
      }
    }
  }
}
