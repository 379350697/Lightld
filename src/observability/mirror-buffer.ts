import type { MirrorEvent } from './mirror-events.ts';

type MirrorBufferOptions = {
  capacity: number;
};

type MirrorBufferSnapshot = {
  queueDepth: number;
  capacity: number;
  droppedEvents: number;
  droppedLowPriority: number;
};

const PRIORITY_RANK = {
  low: 0,
  medium: 1,
  high: 2
} as const;

export class MirrorBuffer {
  private readonly capacity: number;
  private readonly queue: MirrorEvent[] = [];
  private droppedEvents = 0;
  private droppedLowPriority = 0;

  constructor(options: MirrorBufferOptions) {
    this.capacity = options.capacity;
  }

  enqueue(event: MirrorEvent): boolean {
    if (this.queue.length < this.capacity) {
      this.queue.push(event);
      return true;
    }

    const removableIndex = this.findRemovableIndex(event);

    if (removableIndex === -1) {
      this.recordDrop(event);
      return false;
    }

    const [removed] = this.queue.splice(removableIndex, 1);
    this.recordDrop(removed);
    this.queue.push(event);
    return true;
  }

  peek(maxItems: number): MirrorEvent[] {
    return this.queue.slice(0, maxItems);
  }

  ack(count: number): MirrorEvent[] {
    return this.queue.splice(0, count);
  }

  drain(maxItems: number): MirrorEvent[] {
    const events = this.peek(maxItems);
    this.ack(events.length);
    return events;
  }

  snapshot(): MirrorBufferSnapshot {
    return {
      queueDepth: this.queue.length,
      capacity: this.capacity,
      droppedEvents: this.droppedEvents,
      droppedLowPriority: this.droppedLowPriority
    };
  }

  private findRemovableIndex(incoming: MirrorEvent) {
    const incomingRank = PRIORITY_RANK[incoming.priority];
    let candidateIndex = -1;
    let candidateRank = Number.POSITIVE_INFINITY;

    for (let index = 0; index < this.queue.length; index += 1) {
      const queued = this.queue[index];
      const queuedRank = PRIORITY_RANK[queued.priority];

      if (queuedRank < incomingRank && queuedRank < candidateRank) {
        candidateIndex = index;
        candidateRank = queuedRank;
      }
    }

    return candidateIndex;
  }

  private recordDrop(event: MirrorEvent) {
    this.droppedEvents += 1;

    if (event.priority === 'low') {
      this.droppedLowPriority += 1;
    }
  }
}
