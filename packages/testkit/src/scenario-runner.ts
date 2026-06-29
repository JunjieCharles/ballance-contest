import type { ScenarioDefinition, ScenarioEvent } from "@ballance/contracts";
import { assertScenarioDefinition } from "@ballance/contracts";
import { VirtualClock } from "./index.js";

export class ScenarioRunner {
  private readonly events: readonly ScenarioEvent[];
  private cursor = 0;

  public readonly clock: VirtualClock;
  public readonly definition: ScenarioDefinition;

  public constructor(input: unknown) {
    this.definition = assertScenarioDefinition(input);
    this.events = this.definition.events
      .map((event, index) => ({ event, index }))
      .sort((left, right) => left.event.atMs - right.event.atMs || left.index - right.index)
      .map(({ event }) => event);
    this.clock = new VirtualClock(0);
  }

  public next(): ScenarioEvent | undefined {
    const event = this.events[this.cursor];
    if (!event) return undefined;
    this.clock.advanceBy(event.atMs - this.clock.now());
    this.cursor += 1;
    return event;
  }

  public playAll(visit?: (event: ScenarioEvent) => void): readonly ScenarioEvent[] {
    const played: ScenarioEvent[] = [];
    for (let event = this.next(); event; event = this.next()) {
      played.push(event);
      visit?.(event);
    }
    return played;
  }

  public reset(): void {
    this.cursor = 0;
    this.clock.reset();
  }
}
