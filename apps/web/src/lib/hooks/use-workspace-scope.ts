'use client';

import { usePathname } from 'next/navigation';
import { parseWorkspacePath, type WorkspaceScope } from '../workspace-scope';

/**
 * The workspace the visible tab is standing in, for building URLs a browser
 * will NAVIGATE to (`<a href download>`, `<img src>`, `<iframe src>`) — pair
 * it with `withWorkspaceScopeQuery`.
 *
 * Derived from `usePathname()` rather than `window.location`, so the href is
 * identical on the server pass and after hydration (no mismatch, no throw in
 * render), and re-derived on every client navigation so a second tab on
 * another Organization cannot leak its scope into this one.
 *
 * `null` when the path is not a workspace path at all (a malformed
 * `/org/<slug>`). Callers then leave the carrier off and the route runs
 * personal — the same answer a link with no selector gets.
 */
export function useWorkspaceScope(): WorkspaceScope | null {
    const pathname = usePathname();
    try {
        return parseWorkspacePath(pathname ?? '/');
    } catch {
        return null;
    }
}
