'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { APP_LAUNCHER_CLIENT_CACHE_MS, type AppLauncherListResponse } from '@ever-works/contracts';
import type {
    EverAppLauncher,
    LauncherEmptyActionDetail,
    LauncherErrorSection,
    LauncherItemActivateDetail,
    LauncherStrings,
} from '@ever-works/app-launcher';
import {
    captureAppLauncherEvent,
    type AppLauncherOpenSource,
} from '@/lib/app-launcher/app-launcher-telemetry';
import { browserApiFetch } from '@/lib/api/browser-api';
import { ROUTES } from '@/lib/constants';
import { useWorkspaceScope } from '@/lib/hooks/use-workspace-scope';
import { serializeWorkspaceScope } from '@/lib/workspace-scope';
import { useRouter } from '@/i18n/navigation';
import { useAppLauncher } from './AppLauncherProvider';

/**
 * APW-11 T14 — the App Launcher control (plan §6.4).
 *
 * This is the **host** half of the launcher: `packages/app-launcher` draws the
 * panel and this file owns everything the panel must not know — the session, the
 * route, the read and the analytics. The element is created imperatively inside
 * `useEffect` after `await import('@ever-works/app-launcher')`, which is what
 * keeps `customElements` (and Lit) out of server rendering and out of the
 * initial client bundle.
 *
 * Behaviour, and the reason for each piece:
 *
 * - **A 5-minute cache, keyed by the workspace scope.** `GET /api/me/apps` is
 *   answered per scope, so a cache that outlived a scope would show one
 *   Organization's apps inside another (spec FR-66 / ACC-11-49). The key is
 *   `serializeWorkspaceScope(scope)` — the same grammar `browserApiFetch` stamps
 *   on the request as `x-ever-workspace` — so the key and the request cannot
 *   disagree about which scope was read.
 * - **An entry from another scope is never rendered.** The scope key travels
 *   WITH the loaded list and the render reads it back, so a response that lands
 *   after a switch cannot leak into the new scope even for one frame; the switch
 *   additionally closes the panel and drops the stale list.
 * - **Open renders what we have, then revalidates** (FR-5 / FR-6): a cached list
 *   for the active scope renders immediately, and a request goes out only when
 *   that entry is older than {@link APP_LAUNCHER_CLIENT_CACHE_MS} — a second
 *   open inside five minutes performs no fetch at all (ACC-11-03).
 * - **`:retry` refetches**, ignoring the cache, because a person asking again is
 *   not a cache hit (plan §6.4).
 * - **Nothing is fetched until the panel opens.**
 */

/**
 * The element's tag, spelled here rather than imported: importing the package is
 * what the lazy `import()` in the patch effect exists to avoid, and a static
 * import of a constant would pull the whole bundle in.
 */
const EVER_APP_LAUNCHER_TAG = 'ever-app-launcher';

/** The registry read of plan §4.1, through the scope-stamping BFF transport. */
const APPS_ENDPOINT = '/api/me/apps';

/**
 * **Create an App Work** (FR-64). `/works/new` reads a pre-chosen kind from
 * `?kind=` — the convention `WorksCreateComposer` and `NewPageClient` already
 * hand off with (`?mode=ai&kind=…`) — and the element package documents this
 * exact href in `packages/app-launcher/src/index.ts`.
 */
const APP_WORK_CREATE_HREF = `${ROUTES.DASHBOARD_WORKS_NEW}?kind=app`;

/** `platform:<catalogId>` — the key grammar of `AppLauncherItem`. */
const PLATFORM_KEY_PREFIX = 'platform:';

/** The element's reports (plan §6.2), and the handler this control gives each. */
interface LauncherHandlers {
    open: (event: Event) => void;
    close: (event: Event) => void;
    itemActivate: (event: Event) => void;
    manage: (event: Event) => void;
    emptyAction: (event: Event) => void;
    retry: (event: Event) => void;
}

/** Everything the element reads from outside, in one object. */
interface LauncherElementState {
    data: AppLauncherListResponse | null;
    strings: Partial<LauncherStrings>;
    appWorksAvailable: boolean | undefined;
    loading: boolean;
    error: LauncherErrorSection | null;
    handlers: LauncherHandlers;
}

const ELEMENT_EVENTS: ReadonlyArray<readonly [string, keyof LauncherHandlers]> = [
    ['ever-app-launcher:open', 'open'],
    ['ever-app-launcher:close', 'close'],
    ['ever-app-launcher:item-activate', 'itemActivate'],
    ['ever-app-launcher:manage', 'manage'],
    ['ever-app-launcher:empty-action', 'emptyAction'],
    ['ever-app-launcher:retry', 'retry'],
];

/** Plan §6.2's host surface: properties, never attributes. */
function applyElementState(element: EverAppLauncher, state: LauncherElementState): void {
    element.data = state.data;
    element.strings = state.strings;
    element.appWorksAvailable = state.appWorksAvailable;
    element.loading = state.loading;
    element.error = state.error;
    // FR-13's **You're here** is the registry's to mark (`item.current`, or the
    // `platform:<current>` match); this surface knows no catalog id of its own,
    // so it says so with the empty string rather than guessing one.
    element.current = '';
    // `auto` follows `prefers-color-scheme`, which is this app's own default.
    element.theme = 'auto';
}

/** What one scope's read left behind. `scopeKey` pins it to that scope. */
interface ScopedApps {
    scopeKey: string | null;
    data: AppLauncherListResponse | null;
    failed: boolean;
}

/** The module-level cache (plan §6.4): it outlives the control's unmount. */
interface AppLauncherCacheEntry {
    data: AppLauncherListResponse;
    fetchedAt: number;
    scopeKey: string;
}

let appLauncherCache: AppLauncherCacheEntry | null = null;

/**
 * Clear the module cache.
 *
 * Exported for the spec only: the cache is deliberately module-level — that is
 * the point of it, and it is why a second open is free — so a spec cannot reset
 * it by unmounting anything.
 */
export function resetAppLauncherCache(): void {
    appLauncherCache = null;
}

/** The cache entry for this scope, or `null` — never another scope's entry. */
function cacheEntryFor(scopeKey: string | null): AppLauncherCacheEntry | null {
    if (scopeKey === null || appLauncherCache === null) return null;
    return appLauncherCache.scopeKey === scopeKey ? appLauncherCache : null;
}

/**
 * How many visible tiles a section holds, counted the way the panel counts them
 * (`ever-app-launcher.ts > _itemsIn`, plus `_isPinned`'s "pinned wins over the
 * kind's section") so `app_launcher_opened` describes the panel that opened.
 */
function countSection(
    data: AppLauncherListResponse | null,
    section: 'pinned' | 'platforms' | 'works',
): number {
    if (data === null) return 0;
    return data.items.filter((item) => {
        if (item.visible === false) return false;
        if (section === 'pinned') return item.pinned || item.section === 'pinned';
        return item.section === section;
    }).length;
}

/** `platform:cal-diy` → `cal-diy`; anything else has no catalog entry. */
function catalogIdFromKey(key: string): string | undefined {
    return key.startsWith(PLATFORM_KEY_PREFIX) ? key.slice(PLATFORM_KEY_PREFIX.length) : undefined;
}

/**
 * `router.push`, with the failure the panel has to report rather than swallow
 * (ACC-11-48 / `dashboard.appLauncher.emptyActionFailed`). Next's router may
 * throw or reject depending on where the navigation fails, so both are covered.
 */
function pushOrReport(push: (href: string) => unknown, href: string, onFailure: () => void): void {
    try {
        const result = push(href);
        if (result instanceof Promise) void result.catch(onFailure);
    } catch {
        onFailure();
    }
}

/** The control's icon — the same 2×2 grid the element's trigger draws. */
function LauncherControlIcon() {
    return (
        <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            aria-hidden="true"
            focusable="false"
        >
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
    );
}

export function AppLauncherButton() {
    const t = useTranslations('dashboard.appLauncher');
    const router = useRouter();
    const scope = useWorkspaceScope();
    const scopeKey = scope === null ? null : serializeWorkspaceScope(scope);
    const { registerOpenAppLauncher } = useAppLauncher();

    const hostRef = useRef<HTMLDivElement | null>(null);
    const elementRef = useRef<EverAppLauncher | null>(null);
    /**
     * The element's whole outside world, republished on every render.
     *
     * The element is created by an effect, so a handler captured at creation
     * time would close over that render forever. Publishing through a ref lets
     * the creation effect attach listeners and apply state in the same tick it
     * appends the element, and lets every later render reach the element that is
     * already there.
     */
    const stateRef = useRef<LauncherElementState | null>(null);
    /** Which read is current; a response from an older one is dropped. */
    const requestIdRef = useRef(0);
    /** Set by the palette path, consumed by the `:open` handler. */
    const sourceRef = useRef<AppLauncherOpenSource | null>(null);
    /** The palette asked before the chunk landed — open as soon as it does. */
    const pendingOpenRef = useRef(false);
    const previousScopeKeyRef = useRef(scopeKey);

    const [unavailable, setUnavailable] = useState(false);
    const [emptyActionFailed, setEmptyActionFailed] = useState(false);
    const [loading, setLoading] = useState(false);
    const [scoped, setScoped] = useState<ScopedApps | null>(null);

    // The scope key travels with the list and is read back here, so another
    // scope's entry cannot be rendered — not even for the frame a switch lands in.
    const active = scoped !== null && scoped.scopeKey === scopeKey ? scoped : null;
    const data = active?.data ?? null;
    const fetchFailed = active?.failed ?? false;
    const error: LauncherErrorSection | null = fetchFailed
        ? 'apps'
        : data !== null && data.meta.catalogAvailable === false
          ? 'catalog'
          : null;
    const appWorksAvailable = data?.meta.appWorksAvailable;
    const worksTotal = data?.meta.worksTotal ?? 0;

    const strings = useMemo<Partial<LauncherStrings>>(
        () => ({
            controlLabel: t('controlLabel'),
            controlTooltip: t('controlTooltip'),
            panelTitle: t('panelTitle'),
            sectionPinned: t('sectionPinned'),
            sectionPlatforms: t('sectionPlatforms'),
            sectionWorks: t('sectionWorks'),
            chipCurrent: t('chipCurrent'),
            chipBeta: t('chipBeta'),
            chipDeploying: t('chipDeploying'),
            chipLastDeployFailed: t('chipLastDeployFailed'),
            // FR-4's overflow line carries the registry's own total; the element
            // does not render it yet, but the string is exactly what §8 names.
            viewAll: t('viewAll', { count: worksTotal }),
            footerHelper: t('footerHelper'),
            manageLink: t('manageLink'),
            emptyWorks: t('emptyWorks'),
            emptyWorksCreateApp: t('emptyWorksCreateApp'),
            emptyWorksGoToWorks: t('emptyWorksGoToWorks'),
            catalogError: t('catalogError'),
            worksError: t('worksError'),
            retry: t('retry'),
            signInPrompt: t('signInPrompt'),
            signIn: t('signIn'),
        }),
        [t, worksTotal],
    );

    /**
     * Read the registry (FR-33), cache-aware.
     *
     * Renders the entry for the active scope first — that is FR-5's "renders
     * fully within 100 ms of activation" — and then fetches only when that entry
     * is missing or older than five minutes (FR-6). A failed refetch keeps the
     * last good list on screen: S10's "last good" answer, with the error and the
     * retry underneath it.
     */
    const load = useCallback(
        async ({ force = false }: { force?: boolean } = {}) => {
            const cached = cacheEntryFor(scopeKey);
            if (cached !== null) {
                setScoped({ scopeKey, data: cached.data, failed: false });
                if (!force && Date.now() - cached.fetchedAt < APP_LAUNCHER_CLIENT_CACHE_MS) {
                    return;
                }
            }

            const requestId = requestIdRef.current + 1;
            requestIdRef.current = requestId;
            setLoading(true);
            try {
                const response = await browserApiFetch(APPS_ENDPOINT);
                if (!response.ok) {
                    throw new Error(`App launcher read failed with ${response.status}`);
                }
                const payload = (await response.json()) as AppLauncherListResponse;
                if (requestIdRef.current !== requestId) return;
                if (scopeKey !== null) {
                    appLauncherCache = { data: payload, fetchedAt: Date.now(), scopeKey };
                }
                setScoped({ scopeKey, data: payload, failed: false });
            } catch {
                if (requestIdRef.current !== requestId) return;
                setScoped((previous) => ({
                    scopeKey,
                    data:
                        previous !== null && previous.scopeKey === scopeKey ? previous.data : null,
                    failed: true,
                }));
            } finally {
                if (requestIdRef.current === requestId) setLoading(false);
            }
        },
        [scopeKey],
    );

    const handleOpen = useCallback(() => {
        // Read then clear: the palette's mark is consumed by the open it caused,
        // so a later open from the trigger is never blamed on the palette.
        const source = sourceRef.current ?? 'header';
        sourceRef.current = null;
        const rendered = cacheEntryFor(scopeKey)?.data ?? data;
        captureAppLauncherEvent({
            name: 'app_launcher_opened',
            properties: {
                pinned: countSection(rendered, 'pinned'),
                platforms: countSection(rendered, 'platforms'),
                works: countSection(rendered, 'works'),
                source,
            },
        });
        void load();
    }, [data, load, scopeKey]);

    const handleClose = useCallback(() => {
        // A stale mark would mislabel the next open; the element closed, so the
        // open it belonged to is over either way.
        sourceRef.current = null;
    }, []);

    const handleItemActivate = useCallback((event: Event) => {
        // Not cancelled: the element opens the tile's own stored address itself
        // (FR-30). This handler only reports what was opened, and the closed
        // union it reports through has no field for a host, an address or a name
        // (ACC-11-32).
        const detail = (event as CustomEvent<LauncherItemActivateDetail>).detail;
        const catalogId = detail.kind === 'platform' ? catalogIdFromKey(detail.key) : undefined;
        captureAppLauncherEvent({
            name: 'app_launcher_item_opened',
            properties: {
                item_kind: detail.kind,
                ...(catalogId === undefined ? {} : { catalog_id: catalogId }),
                position: detail.position,
                pinned: detail.pinned,
            },
        });
    }, []);

    const handleManage = useCallback(() => {
        router.push(ROUTES.DASHBOARD_SETTINGS_APP_LAUNCHER);
    }, [router]);

    const handleEmptyAction = useCallback(
        (event: Event) => {
            const { action } = (event as CustomEvent<LauncherEmptyActionDetail>).detail;
            setEmptyActionFailed(false);
            pushOrReport(
                (href) => router.push(href),
                action === 'createAppWork' ? APP_WORK_CREATE_HREF : ROUTES.DASHBOARD_WORKS,
                () => setEmptyActionFailed(true),
            );
        },
        [router],
    );

    const handleRetry = useCallback(() => {
        // Both halves come from the one read, and a retry is a person asking
        // again — so it ignores the cache (plan §6.4).
        void load({ force: true });
    }, [load]);

    // ---------------------------------------------------------------------
    // The element
    // ---------------------------------------------------------------------

    /**
     * Lazy element import (plan §6.4): `customElements` and Lit are touched in
     * an effect and never during server rendering or in the first client chunk.
     *
     * The element is created imperatively rather than rendered as JSX so that
     * its properties and its listeners are set **before** it is appended: an
     * element that is already in the DOM is an element a person can click.
     */
    useEffect(() => {
        let cancelled = false;
        let attached: Array<readonly [string, EventListener]> = [];

        void (async () => {
            try {
                await import('@ever-works/app-launcher');
            } catch {
                // §9.2: a chunk that cannot load disables the control; it never
                // takes the header down with it.
                if (!cancelled) setUnavailable(true);
                return;
            }
            if (cancelled || hostRef.current === null) return;

            const element = document.createElement(EVER_APP_LAUNCHER_TAG) as EverAppLauncher;
            elementRef.current = element;
            const state = stateRef.current;
            if (state !== null) applyElementState(element, state);
            attached = ELEMENT_EVENTS.map(([name, key]) => {
                const listener: EventListener = (event) => stateRef.current?.handlers[key](event);
                element.addEventListener(name, listener);
                return [name, listener] as const;
            });
            hostRef.current.appendChild(element);

            if (pendingOpenRef.current) {
                pendingOpenRef.current = false;
                element.show();
            }
        })();

        return () => {
            cancelled = true;
            const element = elementRef.current;
            if (element !== null) {
                for (const [name, listener] of attached) {
                    element.removeEventListener(name, listener);
                }
                element.remove();
            }
            elementRef.current = null;
            attached = [];
        };
    }, []);

    /** Republish the element's outside world, and hand it to the element if it exists. */
    useEffect(() => {
        const state: LauncherElementState = {
            data,
            strings,
            appWorksAvailable,
            loading,
            error,
            handlers: {
                open: handleOpen,
                close: handleClose,
                itemActivate: handleItemActivate,
                manage: handleManage,
                emptyAction: handleEmptyAction,
                retry: handleRetry,
            },
        };
        stateRef.current = state;
        const element = elementRef.current;
        if (element !== null) applyElementState(element, state);
    });

    /**
     * The palette's entry point. The context is the palette's only way in, so a
     * call here is by construction the `palette` source.
     */
    const openFromPalette = useCallback(() => {
        sourceRef.current = 'palette';
        const element = elementRef.current;
        if (element === null) {
            pendingOpenRef.current = true;
            return;
        }
        element.show();
    }, []);

    useEffect(() => {
        registerOpenAppLauncher(openFromPalette);
        return () => registerOpenAppLauncher(null);
    }, [openFromPalette, registerOpenAppLauncher]);

    /**
     * FR-66 / ACC-11-49: another Organization's panel is not this one's. The
     * switch closes it, drops the list, and invalidates any read still in flight
     * so its answer cannot land under the new scope.
     */
    useEffect(() => {
        if (previousScopeKeyRef.current === scopeKey) return;
        previousScopeKeyRef.current = scopeKey;
        requestIdRef.current += 1;
        setLoading(false);
        setScoped(null);
        elementRef.current?.hide();
    }, [scopeKey]);

    if (unavailable) {
        return (
            <div className="relative mt-2" data-testid="app-launcher-control">
                <button
                    type="button"
                    disabled
                    aria-label={t('controlUnavailable')}
                    title={t('controlUnavailable')}
                    data-testid="app-launcher-unavailable"
                    className="cursor-not-allowed rounded-md text-text-secondary opacity-50 dark:text-text-secondary-dark"
                >
                    <LauncherControlIcon />
                </button>
            </div>
        );
    }

    return (
        <div className="relative mt-2" data-testid="app-launcher-control">
            <div ref={hostRef} />
            {emptyActionFailed ? (
                <p
                    role="alert"
                    data-testid="app-launcher-empty-action-error"
                    className="absolute right-0 top-full z-50 mt-1 w-max max-w-64 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-secondary shadow-sm dark:border-border-dark dark:bg-surface-dark dark:text-text-secondary-dark"
                >
                    {t('emptyActionFailed')}
                </p>
            ) : null}
        </div>
    );
}
