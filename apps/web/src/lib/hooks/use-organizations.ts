'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { OrganizationResponse } from '@ever-works/contracts/api';

/**
 * EW-660 (Tenants & Organizations Phase 8) — client-side hook fetching
 * `GET /api/organizations` (proxied by `apps/web/src/app/api/organizations/route.ts`).
 *
 * The spec called for an SWR hook, but SWR is not a dependency of
 * `apps/web` (verified against `package.json`) and Phase 8 explicitly
 * forbids adding new deps. We implement the same surface — cache shared
 * across components, `mutate()` to revalidate — with a module-level
 * store + `useSyncExternalStore`, matching the pattern already used by
 * `use-dashboard-current-work.tsx`.
 *
 * Surface:
 *   - `organizations` — `OrganizationResponse[]` (defaults to `[]` until
 *     the first successful fetch, NOT `undefined`, so the empty-state
 *     check `organizations.length === 0` works on the very first render
 *     without a flash of the active-state chip).
 *   - `isLoading` — `true` until the first fetch resolves (success or
 *     error).
 *   - `error` — `Error | null`. `null` when the last fetch succeeded.
 *   - `mutate()` — re-runs the fetch and updates all subscribers.
 */

type Listener = () => void;

interface OrganizationsStore {
    data: OrganizationResponse[];
    isLoading: boolean;
    error: Error | null;
}

let store: OrganizationsStore = {
    data: [],
    isLoading: true,
    error: null,
};
// `let` rather than `const` because the underlying Set is mutated via
// add/delete/clear throughout the module. Team convention (Greptile P2,
// ref: ever-co/ever-gauzy#8961) prefers `let` for conceptually-mutable
// container vars even when the binding itself isn't reassigned.
let listeners = new Set<Listener>();
let inFlight: Promise<void> | null = null;
let hasFetchedAtLeastOnce = false;

function emit() {
    for (const listener of listeners) {
        listener();
    }
}

function setStore(next: Partial<OrganizationsStore>) {
    store = { ...store, ...next };
    emit();
}

function subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function getSnapshot() {
    return store;
}

function getServerSnapshot() {
    return store;
}

async function fetchOrganizations(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
        try {
            const response = await fetch('/api/organizations', {
                method: 'GET',
                credentials: 'include',
                cache: 'no-store',
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch organizations (${response.status})`);
            }
            const body = (await response.json()) as OrganizationResponse[];
            const data = Array.isArray(body) ? body : [];
            setStore({ data, isLoading: false, error: null });
        } catch (err) {
            // Keep `data` so a transient failure doesn't blow away the
            // user's current org list mid-session (extension, not
            // replacement — NN #20).
            setStore({
                isLoading: false,
                error: err instanceof Error ? err : new Error('Unknown error'),
            });
        } finally {
            hasFetchedAtLeastOnce = true;
            inFlight = null;
        }
    })();
    return inFlight;
}

export interface UseOrganizationsResult {
    organizations: OrganizationResponse[];
    isLoading: boolean;
    error: Error | null;
    mutate: () => Promise<void>;
}

export function useOrganizations(): UseOrganizationsResult {
    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

    useEffect(() => {
        if (!hasFetchedAtLeastOnce) {
            void fetchOrganizations();
        }
    }, []);

    const mutate = useCallback(() => fetchOrganizations(), []);

    return {
        organizations: snapshot.data,
        isLoading: snapshot.isLoading,
        error: snapshot.error,
        mutate,
    };
}

/**
 * Test-only helper. Resets the module-level cache between unit tests so
 * one test's fetched data doesn't bleed into the next. Not exported from
 * any barrel — import the hook module directly.
 */
export function __resetOrganizationsStoreForTests() {
    store = { data: [], isLoading: true, error: null };
    inFlight = null;
    hasFetchedAtLeastOnce = false;
    listeners.clear();
}

/**
 * Test-only helper. Lets a unit test pre-seed the store without going
 * through a real fetch — useful when asserting purely visual states
 * (empty / 1 org / 3 orgs).
 */
export function __seedOrganizationsStoreForTests(next: Partial<OrganizationsStore>) {
    store = { ...store, ...next };
    hasFetchedAtLeastOnce = true;
    emit();
}

// Tiny stand-in to silence TS "unused" complaints from default state
// shape exports; consumers that need a placeholder Loading view rely on
// `isLoading`.
export type { OrganizationsStore };
