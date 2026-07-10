export type PollingClock = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(id: unknown): void;
};

export type PollingVisibility = {
  isHidden(): boolean;
  subscribe(handler: () => void): () => void;
};

export type PollingControllerOptions = {
  task: () => void | Promise<void>;
  visibleIntervalMs: number;
  hiddenIntervalMs: number;
  clock: PollingClock;
  visibility: PollingVisibility;
  onError?: (error: unknown) => void;
};

export class PollingController {
  private timeout: unknown = null;
  private running = false;
  private stopped = true;
  private rerunRequested = false;
  private unsubscribeVisibility: (() => void) | null = null;

  constructor(private readonly options: PollingControllerOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribeVisibility = this.options.visibility.subscribe(() => {
      if (this.options.visibility.isHidden()) this.schedule();
      else this.trigger();
    });
    if (this.options.visibility.isHidden()) this.schedule();
    else this.trigger();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.rerunRequested = false;
    this.clearScheduled();
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
  }

  trigger(): void {
    if (this.stopped) return;
    this.clearScheduled();
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    this.running = true;
    void Promise.resolve()
      .then(this.options.task)
      .catch((error) => this.options.onError?.(error))
      .finally(() => {
        this.running = false;
        if (this.stopped) return;
        if (this.rerunRequested && !this.options.visibility.isHidden()) {
          this.rerunRequested = false;
          this.trigger();
          return;
        }
        this.rerunRequested = false;
        this.schedule();
      });
  }

  private schedule(): void {
    if (this.stopped || this.running) return;
    this.clearScheduled();
    const delay = this.options.visibility.isHidden()
      ? this.options.hiddenIntervalMs
      : this.options.visibleIntervalMs;
    this.timeout = this.options.clock.setTimeout(() => {
      this.timeout = null;
      this.trigger();
    }, delay);
  }

  private clearScheduled(): void {
    if (this.timeout === null) return;
    this.options.clock.clearTimeout(this.timeout);
    this.timeout = null;
  }
}
