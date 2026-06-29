export class VirtualClock {
  public constructor(private currentMs = 0) {}
  public now(): number { return this.currentMs; }
  public advanceBy(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError("milliseconds must be a non-negative finite number");
    }
    this.currentMs += milliseconds;
  }
}
