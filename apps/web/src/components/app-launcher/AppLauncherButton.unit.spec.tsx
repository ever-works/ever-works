import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { APP_LAUNCHER_CLIENT_CACHE_MS, type AppLauncherListResponse } from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';

/**
 * APW-11 T14 — the launcher control (plan §6.4).
 *
 * Four acceptance criteria live here, and each one is a claim about what the
 * **host** does rather than about what the panel renders, because the panel is
 * the element's business (`packages/app-launcher`):
 *
 * - **ACC-11-03** — a second open inside 5 minutes renders from the cache with
 *   no request at all; past the TTL the open refetches.
 * - **ACC-11-49** — switching Organization closes the panel and never renders
 *   the previous scope's items, even though that entry is still cached.
 * - **ACC-11-48** — `:empty-action` routes to the right route for each action,
 *   and a navigation that fails is reported rather than swallowed.
 * - **ACC-11-32** — three tile opens put no host, no address and no Work name
 *   into analytics.
 *
 * The element itself is stubbed: this spec never loads the built bundle (plan
 * §10.4 — the package has its own lane). The control creates the element
 * imperatively, so the spec finds it by tag, asserts the properties the control
 * sets on it, and drives it by dispatching the element's own DOM events.
 */

const pushMock = vi.hoisted(() => vi.fn());
const captureMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
/** The visible path, read by `useWorkspaceScope` and by `browserApiFetch`. */
const pathname = vi.hoisted(() => ({ value: '/' }));
/** Flipped by the chunk-load failure case: the element's import rejects. */
const elementImport = vi.hoisted(() => ({ fail: false }));

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
        values && 'count' in values
            ? `${namespace}.${key}:${String(values.count)}`
            : `${namespace}.${key}`,
}));

vi.mock('next/navigation', () => ({ usePathname: () => pathname.value }));

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock('@/lib/app-launcher/app-launcher-telemetry', () => ({
    captureAppLauncherEvent: captureMock,
}));

/**
 * The element bundle, stubbed — nothing here loads Lit or touches
 * `customElements`; the control only needs the import to resolve.
 *
 * The `then` getter is how the chunk-load failure is simulated. A module
 * namespace that carries a callable `then` is a thenable, so the control's
 * `await import('@ever-works/app-launcher')` **rejects** exactly as it does when
 * the chunk fails to load. It is read on every import, so one test can fail the
 * import while every other test in this file resolves it.
 */
vi.mock('@ever-works/app-launcher', () => ({
    get then() {
        if (!elementImport.fail) return undefined;
        return (_resolve: unknown, reject: (error: Error) => void) =>
            reject(new Error('Failed to load chunk ever-app-launcher'));
    },
}));

import { AppLauncherButton, resetAppLauncherCache } from './AppLauncherButton';
import { AppLauncherProvider, useAppLauncher } from './AppLauncherProvider';

/** What the control sets on the element it creates (plan §6.2 host surface). */
interface LauncherStub extends HTMLElement {
    data: AppLauncherListResponse | null;
    strings: Record<string, string>;
    appWorksAvailable?: boolean;
    loading: boolean;
    error: 'catalog' | 'apps' | null;
    current: string;
    theme: 'light' | 'dark' | 'auto';
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
}

let clock = 1_700_000_000_000;

/**
 * The palette's call site: it only ever sees `openAppLauncher`.
 *
 * Captured on an **object**, not in a module-level `let`: the React Compiler ESLint rule
 * refuses a reassignment of an outer variable from inside a component ("Cannot reassign
 * variables declared outside of the component/hook" — the error this file produced in
 * CI). A property write captures the same value without a binding write, so every
 * assertion below still reads exactly what the component saw.
 */
const captured: { paletteOpener?: () => void } = {};

function PaletteProbe() {
    // Same scoped suppression as `AppLauncherProvider.unit.spec.tsx`, for the same reason:
    // `react-hooks/immutability` guards values the compiler may memoize inside component code,
    // and this probe exists only to hand the context value to this spec's assertions.
    // eslint-disable-next-line react-hooks/immutability -- unit-spec probe: captures the opener for assertions
    captured.paletteOpener = useAppLauncher().openAppLauncher;
    return null;
}

function appsPayload(
    scope: string,
    meta: Partial<AppLauncherListResponse['meta']> = {},
): AppLauncherListResponse {
    // The request carries `personal` / `org:<slug>`; the fixture names its tiles
    // after the slug so a scope mix-up is readable in the assertion diff.
    const token = scope.includes(':') ? scope.slice(scope.indexOf(':') + 1) : scope;
    return {
        items: [
            {
                key: `platform:cloc-${token}`,
                kind: 'platform',
                section: 'pinned',
                name: `Cloc ${token}`,
                url: 'https://cloc-diy-4f2a.app.ever.works/',
                host: 'cloc-diy-4f2a.app.ever.works',
                status: 'available',
                visible: true,
                pinned: true,
                pinOrder: 0,
                order: 0,
                manageState: 'listed',
            },
            {
                key: `platform:docs-${token}`,
                kind: 'platform',
                section: 'platforms',
                name: `Docs ${token}`,
                url: 'https://docs.ever.works/',
                host: 'docs.ever.works',
                status: 'available',
                visible: true,
                pinned: false,
                pinOrder: null,
                order: 1,
                manageState: 'listed',
            },
            {
                key: `work:${token}-1`,
                kind: 'work',
                section: 'works',
                name: `Cloc — my fork (${token})`,
                url: `https://cloc-${token}.app.ever.works/`,
                host: `cloc-${token}.app.ever.works`,
                workKind: 'app',
                visible: true,
                pinned: false,
                pinOrder: null,
                order: 2,
                manageState: 'listed',
            },
            {
                key: `work:${token}-hidden`,
                kind: 'work',
                section: 'works',
                name: `Hidden work (${token})`,
                url: null,
                host: null,
                workKind: 'website',
                visible: false,
                pinned: false,
                pinOrder: null,
                order: 3,
                manageState: 'exposureOff',
            },
        ],
        meta: {
            environment: 'production',
            catalogVersion: '2026-09-17',
            catalogAvailable: true,
            scopeKey: scope,
            worksTotal: 2,
            // The eligible count FR-63 renders; this fixture is not capped, so it
            // is the number of tiles above.
            total: 4,
            truncated: false,
            pinLimit: 6,
            appWorksAvailable: true,
            ...meta,
        },
    };
}

/** Stand where the person stands: the router path and the visible URL agree. */
function visit(path: string): void {
    pathname.value = path;
    window.history.pushState({}, '', path);
}

async function mount(extra?: ReactNode) {
    const utils = render(
        <AppLauncherProvider>
            <AppLauncherButton />
            {extra}
        </AppLauncherProvider>,
    );

    const element = (await waitFor(() => {
        const found = utils.container.querySelector('ever-app-launcher');
        if (found === null) throw new Error('the launcher element is not mounted yet');
        return found;
    })) as LauncherStub;
    element.show = vi.fn();
    element.hide = vi.fn();
    return { ...utils, element };
}

async function openPanel(element: LauncherStub): Promise<void> {
    await act(async () => {
        element.dispatchEvent(new CustomEvent('ever-app-launcher:open', { bubbles: true }));
    });
}

async function closePanel(element: LauncherStub): Promise<void> {
    await act(async () => {
        element.dispatchEvent(new CustomEvent('ever-app-launcher:close', { bubbles: true }));
    });
}

function keysOf(element: LauncherStub): string[] {
    return (element.data?.items ?? []).map((item) => item.key);
}

/** The workspace selector the request actually carried. */
function requestScope(index: number): string | null {
    const call = (fetchMock.mock.calls as [string, RequestInit?][])[index];
    return new Headers(call?.[1]?.headers).get('x-ever-workspace') ?? null;
}

beforeEach(() => {
    resetAppLauncherCache();
    pushMock.mockReset();
    captureMock.mockReset();
    fetchMock.mockReset();
    elementImport.fail = false;
    captured.paletteOpener = undefined;
    clock = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.stubGlobal('fetch', fetchMock);
    visit('/');

    // Every request answers with the list for the scope the request carried, so
    // a scope mismatch shows up in the rendered items instead of passing.
    fetchMock.mockImplementation(async (_input: string, init?: RequestInit) => {
        const scope = new Headers(init?.headers).get('x-ever-workspace') ?? 'personal';
        return { ok: true, status: 200, json: async () => appsPayload(scope) };
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('AppLauncherButton (plan §6.4)', () => {
    it('mounts the lazily imported element into its host and hands it the translated strings', async () => {
        visit('/org/acme/dashboard');
        const { element } = await mount();

        expect(element.tagName.toLowerCase()).toBe('ever-app-launcher');
        expect(element.data).toBeNull();
        expect(element.loading).toBe(false);
        expect(element.error).toBeNull();
        expect(element.current).toBe('');
        expect(element.theme).toBe('auto');
        expect(element.strings.controlLabel).toBe('dashboard.appLauncher.controlLabel');
        expect(element.strings.controlTooltip).toBe('dashboard.appLauncher.controlTooltip');
        expect(element.strings.manageLink).toBe('dashboard.appLauncher.manageLink');
        expect(element.strings.emptyWorksCreateApp).toBe(
            'dashboard.appLauncher.emptyWorksCreateApp',
        );
        expect(element.strings.retry).toBe('dashboard.appLauncher.retry');
        // The `{count}` message follows the registry's total, and no read has
        // happened yet — it is re-derived once the list lands (see ACC-11-03).
        expect(element.strings.viewAll).toBe('dashboard.appLauncher.viewAll:0');
        // Nothing is fetched until the panel is opened (FR-5 / FR-6).
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('renders a second open within 5 minutes from the cache with no fetch, and refetches past the TTL (ACC-11-03)', async () => {
        visit('/org/acme/dashboard');
        const { element } = await mount();
        const fullList = [
            'platform:cloc-acme',
            'platform:docs-acme',
            'work:acme-1',
            'work:acme-hidden',
        ];

        await openPanel(element);
        await waitFor(() => expect(element.data).not.toBeNull());
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(requestScope(0)).toBe('org:acme');
        expect(keysOf(element)).toEqual(fullList);
        // FR-4's overflow line is re-derived from `meta.worksTotal` on the read.
        expect(element.strings.viewAll).toBe('dashboard.appLauncher.viewAll:2');

        // Second open, still inside the window: the cache IS the answer.
        await closePanel(element);
        clock += 4 * 60_000;
        await openPanel(element);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(keysOf(element)).toEqual(fullList);
        expect(element.loading).toBe(false);

        // Past 5 minutes the open refetches.
        await closePanel(element);
        clock += 2 * 60_000;
        await openPanel(element);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(clock - 1_700_000_000_000).toBeGreaterThan(APP_LAUNCHER_CLIENT_CACHE_MS);
        await waitFor(() => expect(element.loading).toBe(false));
        expect(keysOf(element)).toEqual(fullList);
    });

    it('closes the element and never renders the previous Organization after a scope switch (ACC-11-49)', async () => {
        visit('/org/acme/dashboard');
        const { element, rerender } = await mount();

        await openPanel(element);
        await waitFor(() => expect(element.data).not.toBeNull());
        expect(keysOf(element)).toEqual([
            'platform:cloc-acme',
            'platform:docs-acme',
            'work:acme-1',
            'work:acme-hidden',
        ]);

        // The person switches Organization: the visible path — the one input the
        // scope key and the request's selector share — changes.
        visit('/org/beta/dashboard');
        rerender(
            <AppLauncherProvider>
                <AppLauncherButton />
            </AppLauncherProvider>,
        );

        await waitFor(() => expect(element.hide).toHaveBeenCalled());
        await waitFor(() => expect(element.data).toBeNull());

        // …and the next open fetches BETA rather than serving the cached ACME list.
        await openPanel(element);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(requestScope(1)).toBe('org:beta');
        await waitFor(() =>
            expect(keysOf(element)).toEqual([
                'platform:cloc-beta',
                'platform:docs-beta',
                'work:beta-1',
                'work:beta-hidden',
            ]),
        );
        expect(keysOf(element)).not.toContain('work:acme-1');
        expect(JSON.stringify(element.data)).not.toContain('acme');
    });

    it('routes :empty-action to the right route for each detail, and reports a failed navigation (ACC-11-48)', async () => {
        visit('/org/acme/dashboard');
        const { element } = await mount();

        pushMock.mockImplementation(() => undefined);
        await act(async () => {
            element.dispatchEvent(
                new CustomEvent('ever-app-launcher:empty-action', {
                    detail: { action: 'createAppWork' },
                }),
            );
        });
        // `/works/new` reads its pre-chosen kind from `?kind=` (works/new/page.tsx).
        expect(pushMock).toHaveBeenCalledWith(`${ROUTES.DASHBOARD_WORKS_NEW}?kind=app`);

        pushMock.mockClear();
        await act(async () => {
            element.dispatchEvent(
                new CustomEvent('ever-app-launcher:empty-action', {
                    detail: { action: 'goToWorks' },
                }),
            );
        });
        expect(pushMock).toHaveBeenCalledWith(ROUTES.DASHBOARD_WORKS);
        expect(screen.queryByRole('alert')).toBeNull();

        pushMock.mockImplementation(() => {
            throw new Error('navigation failed');
        });
        await act(async () => {
            element.dispatchEvent(
                new CustomEvent('ever-app-launcher:empty-action', {
                    detail: { action: 'createAppWork' },
                }),
            );
        });
        expect(await screen.findByRole('alert')).toHaveTextContent(
            'dashboard.appLauncher.emptyActionFailed',
        );
    });

    it('opens Manage apps on :manage and refetches on :retry (plan §6.4)', async () => {
        visit('/org/acme/dashboard');
        const { element } = await mount();

        await act(async () => {
            element.dispatchEvent(new CustomEvent('ever-app-launcher:manage', { detail: {} }));
        });
        expect(pushMock).toHaveBeenCalledWith(ROUTES.DASHBOARD_SETTINGS_APP_LAUNCHER);

        await openPanel(element);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

        // A retry is a person asking again: it must not be answered from cache.
        await act(async () => {
            element.dispatchEvent(
                new CustomEvent('ever-app-launcher:retry', { detail: { section: 'works' } }),
            );
        });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    });

    it('reports which half failed: apps when the read fails, catalog when the catalog is unavailable', async () => {
        visit('/org/acme/dashboard');
        const { element } = await mount();

        fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
        await openPanel(element);
        await waitFor(() => expect(element.error).toBe('apps'));

        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => appsPayload('acme', { catalogAvailable: false }),
        });
        await act(async () => {
            element.dispatchEvent(
                new CustomEvent('ever-app-launcher:retry', { detail: { section: 'catalog' } }),
            );
        });
        await waitFor(() => expect(element.error).toBe('catalog'));
        expect(element.appWorksAvailable).toBe(true);
    });

    it('reports the source: the palette when the provider opener opened it, the header otherwise', async () => {
        visit('/org/acme/dashboard');
        const { element } = await mount(<PaletteProbe />);

        // A cold open has nothing to count yet — the panel is showing skeletons.
        await openPanel(element);
        expect(captureMock).toHaveBeenCalledWith({
            name: 'app_launcher_opened',
            properties: { pinned: 0, platforms: 0, works: 0, source: 'header' },
        });
        await waitFor(() => expect(element.data).not.toBeNull());
        await closePanel(element);
        captureMock.mockClear();

        // Second open, rendered from the cache: the counts are the panel's.
        await openPanel(element);
        expect(captureMock).toHaveBeenCalledWith({
            name: 'app_launcher_opened',
            properties: { pinned: 1, platforms: 1, works: 1, source: 'header' },
        });

        await closePanel(element);
        captureMock.mockClear();

        // The palette's path: `openAppLauncher()` takes no argument, so the
        // provider's registration is the only thing that can mark the source.
        expect(captured.paletteOpener).toBeTypeOf('function');
        await act(async () => {
            captured.paletteOpener?.();
        });
        expect(element.show).toHaveBeenCalledTimes(1);
        // The real element emits `:open` from inside `show()`.
        await openPanel(element);

        expect(captureMock).toHaveBeenCalledWith({
            name: 'app_launcher_opened',
            properties: { pinned: 1, platforms: 1, works: 1, source: 'palette' },
        });
    });

    it('captures no host, URL or Work name for three tile opens (ACC-11-32)', async () => {
        visit('/org/acme/dashboard');
        const { element } = await mount();

        await openPanel(element);
        await waitFor(() => expect(element.data).not.toBeNull());
        captureMock.mockClear();

        // The element's real detail, plus the two things a tile carries that the
        // detail does not — present so a regression that forwards them is caught.
        const tiles = [
            {
                key: 'platform:cloc-acme',
                kind: 'platform',
                url: 'https://cloc-diy-4f2a.app.ever.works/',
                host: 'cloc-diy-4f2a.app.ever.works',
                name: 'Cloc acme',
                position: 0,
                pinned: true,
            },
            {
                key: 'work:acme-1',
                kind: 'work',
                url: 'https://cloc-acme.app.ever.works/',
                host: 'cloc-acme.app.ever.works',
                name: 'Cloc — my fork (acme)',
                position: 2,
                pinned: false,
            },
            {
                key: 'platform:docs-acme',
                kind: 'platform',
                url: 'https://docs.ever.works/',
                host: 'docs.ever.works',
                name: 'Docs acme',
                position: 1,
                pinned: false,
            },
        ];

        for (const tile of tiles) {
            await act(async () => {
                element.dispatchEvent(
                    new CustomEvent('ever-app-launcher:item-activate', {
                        detail: tile,
                        cancelable: true,
                    }),
                );
            });
        }

        const calls = captureMock.mock.calls.map(
            (call) => call[0] as { name: string; properties: Record<string, unknown> },
        );
        expect(calls).toHaveLength(3);
        const allowed = ['item_kind', 'catalog_id', 'position', 'pinned'];
        for (const call of calls) {
            expect(call.name).toBe('app_launcher_item_opened');
            for (const key of Object.keys(call.properties)) {
                expect(allowed, key).toContain(key);
            }
        }

        // A Work tile carries no catalog entry; a platform tile carries its
        // PUBLIC catalog id — the one identifier allowed to travel.
        expect(calls[0].properties).toEqual({
            item_kind: 'platform',
            catalog_id: 'cloc-acme',
            position: 0,
            pinned: true,
        });
        expect(calls[1].properties).toEqual({ item_kind: 'work', position: 2, pinned: false });
        expect(calls[2].properties).toEqual({
            item_kind: 'platform',
            catalog_id: 'docs-acme',
            position: 1,
            pinned: false,
        });

        const serialized = JSON.stringify(calls);
        for (const tile of tiles) {
            expect(serialized).not.toContain(tile.host);
            expect(serialized).not.toContain(tile.url);
            expect(serialized).not.toContain(tile.name);
        }
    });
});

/**
 * The import rejection lives in the mock above; this case only flips the knob.
 */
describe('AppLauncherButton chunk-load failure', () => {
    it('renders a disabled control with the unavailable string and never throws (plan §9.2)', async () => {
        elementImport.fail = true;

        visit('/org/acme/dashboard');
        const view = render(
            <AppLauncherProvider>
                <AppLauncherButton />
            </AppLauncherProvider>,
        );

        // The rejected import lands a microtask after mount, so the assertion
        // waits for it the way the other cases wait for the read.
        const control = await screen.findByRole('button', {
            name: 'dashboard.appLauncher.controlUnavailable',
        });
        expect(control).toBeDisabled();
        expect(control).toHaveAttribute('title', 'dashboard.appLauncher.controlUnavailable');
        expect(view.container.querySelector('ever-app-launcher')).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
