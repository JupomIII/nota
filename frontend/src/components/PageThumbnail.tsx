import { useEffect, useRef, useState, type ReactNode } from 'react';
import { db } from '../storage/db';

/**
 * A page thumbnail, read only when its tile comes near the viewport.
 *
 * The grids used to read every thumbnail row at once and hand the decoded JPEGs
 * to every image at once, which is fine at twenty pages and hopeless at a few
 * hundred: the library now asks IndexedDB for the covers on screen.
 */
export function PageThumbnail({
  pageId,
  className,
  placeholder,
}: {
  pageId: string | undefined;
  className?: string;
  placeholder: ReactNode;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const tileRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSrc(null);
    if (!pageId) return;
    const node = tileRef.current;
    if (!node) return;
    let cancelled = false;
    const load = async () => {
      const row = await db.thumbnails.get(pageId);
      if (!cancelled) setSrc(row?.dataUrl ?? null);
    };
    if (typeof IntersectionObserver === 'undefined') {
      void load();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void load();
      },
      // A screenful of margin, so a tile is painted before it is scrolled to.
      { rootMargin: '360px' },
    );
    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [pageId]);

  return (
    <div ref={tileRef} className={className}>
      {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : placeholder}
    </div>
  );
}
