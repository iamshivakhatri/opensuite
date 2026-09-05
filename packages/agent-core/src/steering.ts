import type { SteeringMessage } from "./request.js";

/**
 * Steering = mid-run user corrections injected into the active run's transcript
 * before the next model turn (e.g. "use FY2026 instead").
 *
 * Follow-up = a separate later run after the current one finishes — not
 * implemented here.
 */
export interface SteeringSource {
  /** Drain queued messages (empty if none). Deterministic FIFO. */
  drain(): readonly SteeringMessage[];
}

/** Simple in-memory FIFO queue for tests and early application wiring. */
export class InMemorySteeringQueue implements SteeringSource {
  private readonly queue: SteeringMessage[] = [];

  push(message: SteeringMessage): void {
    this.queue.push(message);
  }

  drain(): readonly SteeringMessage[] {
    if (this.queue.length === 0) {
      return [];
    }
    return this.queue.splice(0, this.queue.length);
  }

  get size(): number {
    return this.queue.length;
  }
}
