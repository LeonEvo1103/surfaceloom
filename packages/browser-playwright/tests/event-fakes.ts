/** Minimal listener registry shared by the fake page and context. */
export class FakeEmitter {
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
  public readonly offCalls: string[] = [];

  public on(event: string, handler: (payload: unknown) => void): void {
    const existing = this.handlers.get(event) ?? new Set<(payload: unknown) => void>();
    existing.add(handler);
    this.handlers.set(event, existing);
  }

  public off(event: string, handler: (payload: unknown) => void): void {
    this.offCalls.push(event);
    this.handlers.get(event)?.delete(handler);
  }

  public emit(event: string, payload: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(payload);
  }

  public listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}
