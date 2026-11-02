import { describeError } from "./bridge-client";

export interface DirectoryPageInfo {
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface DirectoryPage<Snapshot> {
  readonly entries: readonly Snapshot[];
  readonly pageInfo: DirectoryPageInfo;
}

export type DirectoryUpdate<Snapshot> =
  | { readonly kind: "upsert"; readonly snapshot: Snapshot }
  | { readonly kind: "remove"; readonly id: string };

export interface DirectoryObserver<Snapshot> {
  snapshot(page: DirectoryPage<Snapshot>): void;
  update(update: DirectoryUpdate<Snapshot>): void;
  error(error: unknown): void;
}

/** A subscribed first page: `listen` attaches the observer, which receives the cached snapshot first. */
export interface OpenedDirectory<Snapshot> {
  listen(observer: DirectoryObserver<Snapshot>): void;
  release(): Promise<void>;
}

/** How a directory reaches the daemon: one subscription, then plain pages after the first. */
export interface DirectorySource<Snapshot> {
  /** The plural noun for logs, such as "agents". */
  readonly noun: string;
  open(): Promise<OpenedDirectory<Snapshot>>;
  page(cursor: string): Promise<DirectoryPage<Snapshot>>;
}

export interface LiveDirectoryOptions<Snapshot, Item> {
  source: DirectorySource<Snapshot>;
  idOf(snapshot: Snapshot): string;
  toItem(snapshot: Snapshot): Item;
  /** Called with every item the directory holds after each change. */
  onChange(items: ReadonlyMap<string, Item>): void;
  log(message: string): void;
  /** How long to wait before subscribing or paging again after a failure. */
  retryMs?: number;
}

/** A guard against a cursor that never ends. */
const MAX_PAGES = 50;

/**
 * A live, paged directory of daemon objects, such as agents or workspaces.
 *
 * It subscribes once and keeps the last complete directory until every page of a new
 * snapshot has loaded; updates that arrive meanwhile apply over the loaded pages.
 */
export class LiveDirectory<Snapshot, Item> {
  private readonly options: LiveDirectoryOptions<Snapshot, Item>;
  private readonly items = new Map<string, Item>();
  private release: (() => Promise<void>) | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private pageRetryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Counts snapshots, so that pages of an older snapshot are discarded. */
  private generation = 0;
  /** Items updated or removed since the latest snapshot; later pages do not overwrite them. */
  private readonly touched = new Set<string>();

  constructor(options: LiveDirectoryOptions<Snapshot, Item>) {
    this.options = options;
  }

  start(): void {
    void this.subscribe();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    this.clearPageRetry();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const release = this.release;
    this.release = null;
    await release?.().catch(() => undefined);
  }

  /** Removes an item at once, ahead of the directory update, when a hook reports it gone. */
  forget(id: string): void {
    this.touched.add(id);
    if (this.items.delete(id)) this.options.onChange(this.items);
  }

  private get noun(): string {
    return this.options.source.noun;
  }

  private async subscribe(): Promise<void> {
    if (this.stopped) return;
    try {
      const opened = await this.options.source.open();
      if (this.stopped) {
        await opened.release();
        return;
      }
      this.release = () => opened.release();
      opened.listen({
        snapshot: (page) => this.replace(page),
        update: (update) => {
          if (this.stopped) return;
          if (update.kind === "upsert") this.upsert(update.snapshot);
          else this.forget(update.id);
        },
        error: (error) => {
          this.options.log(`The ${this.noun} subscription stopped: ${describeError(error)}`);
          this.generation += 1;
          this.clearPageRetry();
          const release = this.release;
          this.release = null;
          void release?.().catch(() => undefined);
          this.scheduleRetry();
        },
      });
      // listen delivers the cached snapshot, then buffered updates.
      // Starting pagination here too would fetch every later page twice.
    } catch (error) {
      this.options.log(`Could not list ${this.noun}: ${describeError(error)}`);
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.subscribe();
    }, this.options.retryMs ?? 5_000);
    this.retryTimer.unref();
  }

  private clearPageRetry(): void {
    if (this.pageRetryTimer) clearTimeout(this.pageRetryTimer);
    this.pageRetryTimer = null;
  }

  /** Builds a replacement without removing items from the last complete directory. */
  private replace(page: DirectoryPage<Snapshot>): void {
    if (this.stopped) return;
    this.generation += 1;
    this.clearPageRetry();
    this.touched.clear();
    const firstPage = new Map(
      page.entries.map((snapshot) => [this.options.idOf(snapshot), this.options.toItem(snapshot)]),
    );
    void this.loadPages(firstPage, page.pageInfo, this.generation);
  }

  /** Publishes all pages together, with updates received since the snapshot applied last. */
  private async loadPages(
    firstPage: ReadonlyMap<string, Item>,
    first: DirectoryPageInfo,
    generation: number,
  ): Promise<void> {
    const replacement = new Map(firstPage);
    const cursors = new Set<string>();
    let pageInfo = first;
    try {
      while (pageInfo.hasMore) {
        const cursor = pageInfo.nextCursor;
        if (cursor === null || cursors.has(cursor) || cursors.size >= MAX_PAGES) {
          throw new Error(`The ${this.noun} directory returned incomplete pagination`);
        }
        cursors.add(cursor);
        const page = await this.options.source.page(cursor);
        if (this.stopped || generation !== this.generation) return;
        for (const snapshot of page.entries) {
          replacement.set(this.options.idOf(snapshot), this.options.toItem(snapshot));
        }
        pageInfo = page.pageInfo;
      }
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      this.options.log(`Could not list more ${this.noun}: ${describeError(error)}`);
      this.pageRetryTimer = setTimeout(() => {
        this.pageRetryTimer = null;
        void this.loadPages(firstPage, first, generation);
      }, this.options.retryMs ?? 5_000);
      this.pageRetryTimer.unref();
      return;
    }
    if (this.stopped || generation !== this.generation) return;
    for (const id of this.touched) {
      const current = this.items.get(id);
      if (current) replacement.set(id, current);
      else replacement.delete(id);
    }
    this.items.clear();
    for (const [id, item] of replacement) this.items.set(id, item);
    this.options.onChange(this.items);
  }

  private upsert(snapshot: Snapshot): void {
    const id = this.options.idOf(snapshot);
    this.touched.add(id);
    this.items.set(id, this.options.toItem(snapshot));
    this.options.onChange(this.items);
  }
}
