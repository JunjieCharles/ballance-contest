export interface JournalEvent<T = unknown> {
  sequence: number;
  type: string;
  occurredAt: string;
  competitionId?: string;
  stateVersion?: number;
  data: T;
}

export class EventJournal {
  private sequence = 0;
  private readonly events: JournalEvent[] = [];
  private readonly listeners = new Set<(event: JournalEvent) => void>();

  public constructor(private readonly capacity = 10_000) {}

  public append<T>(event: Omit<JournalEvent<T>, "sequence" | "occurredAt">): JournalEvent<T> {
    const recorded: JournalEvent<T> = { ...event, sequence: ++this.sequence, occurredAt: new Date().toISOString() };
    this.events.push(recorded);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    for (const listener of this.listeners) listener(recorded);
    return recorded;
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
}
