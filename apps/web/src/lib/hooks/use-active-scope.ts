'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import type { OrganizationResponse } from '@ever-works/contracts/api';
import { useOrganizations } from './use-organizations';

export interface UseActiveScopeResult {
    /**
     * The slug from the URL — `/[slug]/...`. Returns `null` when the
     * route doesn't carry a slug (e.g. bare `/dashboard`,
     * `/[userSlug]/dashboard` before Phase 7 web-side wiring lands, or
     * when navigating outside the slug-prefixed routes entirely).
     */
    slug: string | null;
    /**
     * The Organization whose `slug` matches the URL slug. `null` when
     * the user is in bare-Tenant scope, when the URL doesn't carry an
     * org slug, or when the slug exists but isn't in the user's
     * fetched org list (defensive fallback — shouldn't normally happen
     * because the API only returns orgs the user can see).
     */
    activeOrganization: OrganizationResponse | null;
    /** Update the local view only after the server confirms a persisted switch. */
    setActiveOrganization: (organization: OrganizationResponse | null) => void;
}

interface ActiveScopeResponse {
    tenantId: string | null;
    organizationId: string | null;
    organizationSlug: string | null;
}

/**
 * EW-660 (Tenants & Organizations Phase 8) — derives the user's active
 * Organization from the URL slug. Reads `useParams()` from the App
 * Router (Phase 7's `[slug]` segment, when it lands web-side) and
 * cross-references it against `useOrganizations()`.
 *
 * Today most users have zero organizations and bare-Tenant routes don't
 * carry a slug, so this hook will return `{ slug: null,
 * activeOrganization: null }` for them — the WorkspaceSwitcher uses
 * that signal plus `organizations.length === 0` to render the
 * empty-state logo.
 */
export function useActiveScope(): UseActiveScopeResult {
    const params = useParams<{ slug?: string | string[] }>();
    const { organizations } = useOrganizations();
    const [persistedSlug, setPersistedSlug] = useState<string | null>(null);
    const selectionVersion = useRef(0);

    const rawSlug = params?.slug;
    const routeSlug = Array.isArray(rawSlug) ? (rawSlug[0] ?? null) : (rawSlug ?? null);

    useEffect(() => {
        if (routeSlug) return;

        let cancelled = false;
        const versionAtRequestStart = selectionVersion.current;
        void (async () => {
            try {
                const response = await fetch('/api/users/me/scope', {
                    method: 'GET',
                    credentials: 'include',
                    cache: 'no-store',
                });
                if (!response.ok) return;
                const body = (await response.json()) as ActiveScopeResponse;
                if (!cancelled && selectionVersion.current === versionAtRequestStart) {
                    setPersistedSlug(body.organizationSlug ?? null);
                }
            } catch {
                // Keep the current local selection on transient BFF/network failures.
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [routeSlug]);

    const setActiveOrganization = useCallback((organization: OrganizationResponse | null) => {
        selectionVersion.current += 1;
        setPersistedSlug(organization?.slug ?? null);
    }, []);

    const slug = routeSlug ?? persistedSlug;

    const activeOrganization = slug
        ? (organizations.find((org) => org.slug === slug) ?? null)
        : null;

    return { slug, activeOrganization, setActiveOrganization };
}
