import type { PageContent } from '../drawing/engine';

/**
 * What the open editor hands the refresher: its pending writes, a way to read
 * the page again, and the engine that swaps the content in.
 */
export interface OpenPage {
  readonly pageId: string;
  /** Local writes go first, so the reload includes them instead of replacing them. */
  flush: () => Promise<void>;
  load: (pageId: string) => Promise<PageContent>;
  apply: (content: PageContent) => void;
  /** Bitmaps for images the pull brought, cached by the editor. */
  afterApply?: (content: PageContent) => Promise<void> | void;
  /** False when the reader turned the page while the reload was running. */
  isCurrent?: () => boolean;
}

/**
 * Turns a sync revision into exactly one reload of the open page.
 *
 * The order is the point. Local writes are flushed *before* the page is read
 * again: with the reverse order, a pull would load a page without the strokes
 * the reader had just drawn, and the buffer would then write them over the
 * newer copy. A revision that lands while a reload is running waits for it and
 * is applied afterwards, so no revision is lost and none is applied twice.
 */
export class PageRefresher {
  private seen: number;
  private running: Promise<boolean> | null = null;

  constructor(initialRevision = 0) {
    this.seen = initialRevision;
  }

  async apply(revision: number, page: OpenPage | null): Promise<boolean> {
    if (revision === this.seen) return false;
    if (this.running) await this.running.catch(() => false);
    // The reload that just finished may already have taken this revision.
    if (revision === this.seen) return false;
    this.seen = revision;
    if (!page) return false;
    const run = (async (): Promise<boolean> => {
      await page.flush();
      const content = await page.load(page.pageId);
      // The reader may have turned the page while this was running: the content
      // of one page must never be swapped into another.
      if (page.isCurrent && !page.isCurrent()) return false;
      page.apply(content);
      await page.afterApply?.(content);
      return true;
    })();
    this.running = run;
    try {
      return await run;
    } finally {
      this.running = null;
    }
  }
}
