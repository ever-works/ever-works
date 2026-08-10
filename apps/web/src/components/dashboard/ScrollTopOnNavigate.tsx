'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

// On the server `useLayoutEffect` is a no-op and React warns about it; fall
// back to `useEffect` there. The client path must stay layout-phase — see the
// ordering note below.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Resets the dashboard scroll container to the top on every route change.
 *
 * The dashboard scrolls inside `<main id="main-content">`, not the document.
 * Next's App Router scroll handling assumes the document scroller: it sets
 * `document.documentElement.scrollTop = 0` (a no-op for us) and, when the new
 * segment's top edge isn't already in the viewport, falls back to
 * `domNode.scrollIntoView()` on that segment's first DOM node. `scrollIntoView`
 * walks up to the nearest scrollable ancestor — `#main-content` — and pins the
 * *segment* to the top of it.
 *
 * The segment that wins is the deepest newly-mounted one, because the handler
 * runs in `componentDidMount` and layout-phase effects commit bottom-up. On
 * `/works/[id]` that is the page, not the layout, so arriving with the
 * container already scrolled (e.g. clicking a Work from a scrolled `/works`
 * list) parked the page body at the top and pushed `WorkHeader` + `WorkTabs`
 * out of view.
 *
 * Ordering: render this AFTER the routed children so its layout effect runs
 * after Next's handler in the same commit — that overrides the segment scroll
 * before paint, so there is no visible jump.
 */
export function ScrollTopOnNavigate() {
    const pathname = usePathname();
    const lastPathname = useRef<string | null>(null);

    useIsomorphicLayoutEffect(() => {
        const isFirstRender = lastPathname.current === null;
        const isSamePath = lastPathname.current === pathname;
        lastPathname.current = pathname;

        // Search-param-only changes (pagination, filters, view modes) keep the
        // reader in place — those views manage their own scroll.
        if (isFirstRender || isSamePath) {
            return;
        }

        // A hash target is an explicit request to land somewhere other than the
        // top; leave Next's hash handling alone.
        if (window.location.hash) {
            return;
        }

        document.getElementById('main-content')?.scrollTo({ top: 0 });
    }, [pathname]);

    return null;
}
