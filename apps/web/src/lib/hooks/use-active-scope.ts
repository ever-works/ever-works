'use client';

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

    const rawSlug = params?.slug;
    const slug = Array.isArray(rawSlug) ? (rawSlug[0] ?? null) : (rawSlug ?? null);

    const activeOrganization = slug
        ? (organizations.find((org) => org.slug === slug) ?? null)
        : null;

    return { slug, activeOrganization };
}
