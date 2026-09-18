import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    AppLauncherItem,
    AppLauncherListResponse,
    AppLauncherPreferenceChange,
    AppLauncherSavePreferencesResponse,
} from '@ever-works/contracts';

/**
 * APW-11 T16 — the **Manage apps** editor (plan §7, spec FR-27, FR-38, FR-41,
 * FR-62, FR-63; ACC-11-18 unit half, ACC-11-19, ACC-11-47).
 *
 * ## Why the real `en.json` is the translator here
 *
 * The three acceptance criteria this file carries are about **copy**: the
 * seventh pin is disabled *with the sentence* "Six pins is the limit. Unpin one
 * first.", and FR-63 renders *exactly* `Showing 200 of {count}`. A stub
 * `useTranslations` that echoes the key back would let a renamed or missing key
 * pass, so `next-intl` is mocked with a resolver over the shipped
 * `apps/web/messages/en.json` instead: an assertion on the sentence is an
 * assertion that the key exists, that its value is the plan §8 one, and that
 * the component interpolates `{count}`/`{name}`/`{organization}` correctly.
 *
 * ## Why the debounce is driven by fake timers
 *
 * FR-28 is "one save per batch", and T16's Test line asserts the batch is
 * **one** call. Only a controlled clock can prove *both* halves: that nothing
 * is sent before 500 ms, and that a second change restarts the window rather
 * than opening a second batch.
 */

vi.mock('next-intl', async () => {
    const { readFileSync: read } = await import('node:fs');
    const { join: joinPath } = await import('node:path');
    const bundle = JSON.parse(
        read(joinPath(__dirname, '..', '..', '..', 'messages', 'en.json'), 'utf8'),
    ) as Record<string, unknown>;

    const resolve = (path: string): unknown =>
        path.split('.').reduce<unknown>((node, segment) => {
            if (node && typeof node === 'object') {
                return (node as Record<string, unknown>)[segment];
            }
            return undefined;
        }, bundle);

    return {
        useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
            const raw = resolve(`${namespace}.${key}`);
            if (typeof raw !== 'string') {
                throw new Error(`missing message ${namespace}.${key}`);
            }
            if (values === undefined) return raw;
            return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
                name in values ? String(values[name]) : match,
            );
        },
    };
});

/** The workspace the page is standing in — organization scope unless a test says otherwise. */
let workspaceScope: unknown = { kind: 'organization', slug: 'acme' };
vi.mock('@/lib/hooks/use-workspace-scope', () => ({
    useWorkspaceScope: () => workspaceScope,
}));

vi.mock('@/app/actions/settings/app-launcher', () => ({
    saveAppLauncherPreferencesAction: vi.fn(),
    readAppLauncherListAction: vi.fn(),
}));

import {
    readAppLauncherListAction,
    saveAppLauncherPreferencesAction,
} from '@/app/actions/settings/app-launcher';
import { AppLauncherSettings, FILTER_DEBOUNCE_MS, SAVE_DEBOUNCE_MS } from './AppLauncherSettings';

const saveAction = vi.mocked(saveAppLauncherPreferencesAction);
const readAction = vi.mocked(readAppLauncherListAction);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** `work:<uuid>` — the key grammar the save DTO accepts (plan §4.2:405). */
function workKey(n: number): string {
    return `work:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

type ItemOverrides = Partial<AppLauncherItem>;

function platformItem(id: string, overrides: ItemOverrides = {}): AppLauncherItem {
    return {
        key: `platform:${id}`,
        kind: 'platform',
        section: 'platforms',
        name: `Ever ${id}`,
        url: `https://${id}.example.com`,
        host: `${id}.example.com`,
        visible: true,
        pinned: false,
        pinOrder: null,
        order: 0,
        manageState: 'listed',
        status: 'available',
        ...overrides,
    };
}

function workItem(n: number, overrides: ItemOverrides = {}): AppLauncherItem {
    return {
        key: workKey(n),
        kind: 'work',
        section: 'works',
        name: `Work ${n}`,
        url: `https://work-${n}.example.com`,
        host: `work-${n}.example.com`,
        workKind: 'app',
        visible: true,
        pinned: false,
        pinOrder: null,
        order: 0,
        manageState: 'listed',
        ...overrides,
    };
}

function meta(
    overrides: Partial<AppLauncherListResponse['meta']> = {},
): AppLauncherListResponse['meta'] {
    return {
        environment: 'production',
        catalogVersion: 'catalog-1',
        catalogAvailable: true,
        scopeKey: 'org-1',
        worksTotal: 0,
        // `total` is FR-63's `{count}` — the eligible count the read reported.
        // Only the count line renders it, and only a truncated read renders the
        // count line, so a fixture that shows it states its own number.
        total: 0,
        truncated: false,
        pinLimit: 6,
        appWorksAvailable: true,
        ...overrides,
    };
}

/** A successful `GET /api/me/apps`, as the filter read answers it. */
function listedResponse(
    items: AppLauncherItem[],
    overrides: Partial<AppLauncherListResponse['meta']> = {},
): Awaited<ReturnType<typeof readAppLauncherListAction>> {
    return { success: true, data: { items, meta: meta(overrides) }, error: null };
}

/** A successful save, echoing the list the editor should re-render from. */
function savedResponse(
    items: AppLauncherItem[],
): Awaited<ReturnType<typeof saveAppLauncherPreferencesAction>> {
    const data: AppLauncherSavePreferencesResponse = { saved: 1, rejected: [], items };
    return { success: true, data, error: null };
}

/**
 * The API's answer to one save, in miniature: apply the merge patch per key and
 * re-number each section that carried explicit orders.
 *
 * The real `PUT /api/me/apps/preferences` answers with the refreshed
 * `includeHidden=true` list (plan §4.2:437-438), and the editor re-renders from
 * it — so a spec that answered with the untouched input would test a second
 * move against an arrangement the server never returned.
 */
function applyChanges(
    items: AppLauncherItem[],
    changes: AppLauncherPreferenceChange[],
): AppLauncherItem[] {
    const byKey = new Map(changes.map((change) => [change.key, change]));
    const patched = items.map((item) => {
        const change = byKey.get(item.key);
        if (change === undefined) return item;
        const next = { ...item };
        if (change.visible !== undefined) next.visible = change.visible;
        if (change.pinned !== undefined) next.pinned = change.pinned;
        if (change.order !== undefined) next.order = change.order;
        return next;
    });

    const reorderedSections = new Set(
        changes
            .filter((change) => change.order !== undefined)
            .map((change) => items.find((item) => item.key === change.key)?.section),
    );

    let out = patched;
    for (const section of reorderedSections) {
        const positions = out
            .map((item, index) => (item.section === section ? index : -1))
            .filter((index) => index >= 0);
        const rows = positions
            .map((index) => out[index])
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const next = [...out];
        positions.forEach((index, cursor) => {
            next[index] = rows[cursor];
        });
        out = next;
    }
    return out;
}

function renderEditor(
    items: AppLauncherItem[],
    options: { meta?: AppLauncherListResponse['meta']; loadFailed?: boolean } = {},
): void {
    render(
        <AppLauncherSettings
            initialItems={items}
            initialMeta={options.meta ?? meta()}
            loadFailed={options.loadFailed ?? false}
        />,
    );
}

/** One row, by the item key it renders. */
function rowFor(key: string): HTMLElement {
    const element = document.querySelector(`[data-item-key="${key}"]`);
    if (!(element instanceof HTMLElement)) {
        throw new Error(`no rendered row for ${key}`);
    }
    return element;
}

/** One control inside that row. */
function controlFor(key: string, testId: string): HTMLElement {
    return within(rowFor(key)).getByTestId(testId);
}

/** The `changes` array of the n-th save, or `null` when there was none. */
function saveChanges(call: number): AppLauncherPreferenceChange[] | null {
    const invocation = saveAction.mock.calls[call];
    return invocation === undefined ? null : invocation[0];
}

/** Flush the trailing 500 ms window and let the mocked action settle. */
async function flushDebounce(): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
    });
}

/**
 * Flush the filter's own — much shorter — window and let its read settle.
 *
 * FR-63's filter is a **read**, so it must not borrow
 * {@link SAVE_DEBOUNCE_MS}: a save's half-second would mean half a second of
 * typing before the server is asked, and the two windows are asserted to be
 * different numbers by `asks the server on its own debounce` below.
 */
async function flushFilterDebounce(): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(FILTER_DEBOUNCE_MS);
    });
}

/** Every key with an explicit `order` in one save. */
function orderedKeys(changes: AppLauncherPreferenceChange[]): string[] {
    return changes.filter((change) => change.order !== undefined).map((change) => change.key);
}

beforeEach(() => {
    vi.useFakeTimers();
    saveAction.mockReset();
    readAction.mockReset();
    // The filter read answers "nothing new" unless a test says otherwise, so the
    // list a fixture handed in is the list the editor renders.
    readAction.mockResolvedValue(listedResponse([]));
    workspaceScope = { kind: 'organization', slug: 'acme' };
});

afterEach(() => {
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

describe('AppLauncherSettings — the list (FR-27)', () => {
    it('renders the intro, the two columns and every row under its section heading', () => {
        const pinned = workItem(1, { section: 'pinned', pinned: true, pinOrder: 0 });
        renderEditor([pinned, platformItem('gauzy'), workItem(2)], {
            meta: meta({ worksTotal: 2 }),
        });

        expect(
            screen.getByText('Choose what the App Launcher shows you. Only you see these choices.'),
        ).toBeInTheDocument();
        expect(screen.getByText('Show')).toBeInTheDocument();
        expect(screen.getByText('Pin')).toBeInTheDocument();

        // The heading names the section the server put each row in, and the
        // Works heading names the Organization the read was scoped to.
        expect(screen.getByText('Pinned')).toBeInTheDocument();
        expect(screen.getByText('Ever apps')).toBeInTheDocument();
        expect(screen.getByText('Your apps in acme')).toBeInTheDocument();

        expect(rowFor(pinned.key)).toBeInTheDocument();
        expect(rowFor('platform:gauzy')).toBeInTheDocument();
        expect(rowFor(workKey(2))).toBeInTheDocument();
    });

    it('names each control after the app it acts on (FR-38/FR-41 accessible names)', () => {
        renderEditor([workItem(7)], { meta: meta({ worksTotal: 1 }) });

        expect(controlFor(workKey(7), 'app-launcher-show')).toHaveAccessibleName('Show Work 7');
        expect(controlFor(workKey(7), 'app-launcher-pin')).toHaveAccessibleName('Pin Work 7');
        expect(controlFor(workKey(7), 'app-launcher-drag')).toHaveAccessibleName('Reorder Work 7');
        expect(controlFor(workKey(7), 'app-launcher-move-up')).toHaveAccessibleName('Move up');
        expect(controlFor(workKey(7), 'app-launcher-move-down')).toHaveAccessibleName('Move down');
    });

    it('falls back to the personal heading outside an Organization workspace', () => {
        workspaceScope = { kind: 'personal' };
        renderEditor([workItem(1)], { meta: meta({ worksTotal: 1 }) });

        expect(screen.getByText('Your apps')).toBeInTheDocument();
        expect(screen.queryByText('Your apps in acme')).toBeNull();
    });

    it('marks a not-live row and a Work-hidden row, and only the Work-hidden one cannot be shown', () => {
        renderEditor(
            [
                workItem(1, { manageState: 'notLive', url: null, host: null }),
                workItem(2, { manageState: 'exposureOff', url: null, host: null }),
            ],
            { meta: meta({ worksTotal: 2 }) },
        );

        expect(screen.getByText('Not live — no address')).toBeInTheDocument();
        expect(
            screen.getByText("Hidden by the Work · Turn on in the Work's settings"),
        ).toBeInTheDocument();

        // FR-59's exposure switch belongs to the Work: the person's Show
        // control cannot override it, so it is offered disabled rather than
        // accepted and then refused by the API.
        expect(controlFor(workKey(2), 'app-launcher-show')).toBeDisabled();
        expect(controlFor(workKey(1), 'app-launcher-show')).not.toBeDisabled();
    });

    it('renders the load failure instead of an empty list when the page read failed', () => {
        renderEditor([], { loadFailed: true });

        expect(screen.getByTestId('app-launcher-load-error')).toHaveTextContent(
            "Your apps couldn't be loaded.",
        );
        expect(screen.queryAllByTestId('app-launcher-row')).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// The save (FR-28, ACC-11-18 unit half)
// ---------------------------------------------------------------------------

describe('AppLauncherSettings — the debounced batch save (FR-28, FR-29)', () => {
    it('batches two changes inside the 500 ms window into ONE save', async () => {
        renderEditor([platformItem('gauzy'), platformItem('cal'), platformItem('chat')], {
            meta: meta(),
        });

        fireEvent.click(controlFor('platform:gauzy', 'app-launcher-show'));
        expect(screen.getByTestId('app-launcher-save-state')).toHaveTextContent('Saving…');

        // Half-way through the window: nothing has been sent.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300);
        });
        expect(saveAction).not.toHaveBeenCalled();

        // A second change restarts the window rather than opening a second batch.
        fireEvent.click(controlFor('platform:cal', 'app-launcher-show'));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300);
        });
        expect(saveAction).not.toHaveBeenCalled();

        saveAction.mockResolvedValue(
            savedResponse([
                platformItem('gauzy', { visible: false }),
                platformItem('cal', { visible: false }),
                platformItem('chat'),
            ]),
        );
        await flushDebounce();

        expect(saveAction).toHaveBeenCalledTimes(1);
        expect(saveChanges(0)).toEqual([
            { key: 'platform:gauzy', visible: false },
            { key: 'platform:cal', visible: false },
        ]);
        expect(screen.getByTestId('app-launcher-save-state')).toHaveTextContent('Saved');
    });

    it('re-renders from the list the save returned, not from the optimistic copy', async () => {
        renderEditor([workItem(1), workItem(2)], { meta: meta({ worksTotal: 2 }) });
        saveAction.mockResolvedValue(
            savedResponse([
                // The server is the authority: it answered with row 2 pinned,
                // which is the arrangement a reload must reproduce.
                workItem(1),
                workItem(2, { section: 'pinned', pinned: true, pinOrder: 0 }),
            ]),
        );

        fireEvent.click(controlFor(workKey(2), 'app-launcher-pin'));
        await flushDebounce();

        expect(saveChanges(0)).toEqual([{ key: workKey(2), pinned: true }]);
        expect(rowFor(workKey(2))).toHaveAttribute('data-section', 'pinned');
    });

    it('shows the failure copy and keeps the change pending for the next attempt', async () => {
        renderEditor([platformItem('gauzy')], { meta: meta() });
        saveAction.mockResolvedValueOnce({
            success: false,
            data: null,
            error: 'pinLimit',
        });

        fireEvent.click(controlFor('platform:gauzy', 'app-launcher-show'));
        await flushDebounce();

        expect(screen.getByTestId('app-launcher-save-state')).toHaveTextContent(
            "Couldn't save. Try again.",
        );

        // The person's next action re-sends the change that failed, so a retry
        // never silently drops the choice they made.
        saveAction.mockResolvedValueOnce(
            savedResponse([platformItem('gauzy', { visible: false })]),
        );
        fireEvent.click(controlFor('platform:gauzy', 'app-launcher-show'));
        await flushDebounce();

        expect(saveAction).toHaveBeenCalledTimes(2);
        expect(saveChanges(1)).toEqual([{ key: 'platform:gauzy', visible: true }]);
    });
});

// ---------------------------------------------------------------------------
// Pins (FR-25, ACC-11-18/ACC-11-19)
// ---------------------------------------------------------------------------

describe('AppLauncherSettings — the pin budget (FR-25, FR-62)', () => {
    /** Six pinned rows (the whole budget) plus one the person may still pin. */
    function sixPinsAndOne(): AppLauncherItem[] {
        return [
            platformItem('gauzy', { section: 'pinned', pinned: true, pinOrder: 0 }),
            platformItem('cal', { section: 'pinned', pinned: true, pinOrder: 1 }),
            platformItem('chat', { section: 'pinned', pinned: true, pinOrder: 2 }),
            workItem(1, { section: 'pinned', pinned: true, pinOrder: 3 }),
            workItem(2, { section: 'pinned', pinned: true, pinOrder: 4 }),
            workItem(3, { section: 'pinned', pinned: true, pinOrder: 5 }),
            workItem(4),
        ];
    }

    it('counts the merged pins the read reported', () => {
        renderEditor(sixPinsAndOne(), { meta: meta({ worksTotal: 4 }) });

        expect(screen.getByTestId('app-launcher-pin-counter')).toHaveTextContent(
            '6 of 6 pins used',
        );
    });

    it('disables the seventh pin with the FR-25 sentence', () => {
        renderEditor(sixPinsAndOne(), { meta: meta({ worksTotal: 4 }) });

        const seventh = controlFor(workKey(4), 'app-launcher-pin');
        expect(seventh).toBeDisabled();
        expect(seventh).toHaveAttribute('title', 'Six pins is the limit. Unpin one first.');

        // Control: the six that hold the budget keep a working switch, so
        // "disabled" above means the budget and not a broken control.
        expect(controlFor(workKey(3), 'app-launcher-pin')).not.toBeDisabled();
        expect(controlFor(workKey(3), 'app-launcher-pin')).not.toHaveAttribute('title');
    });

    it('allows the seventh pin once one of the six is released', async () => {
        const released = sixPinsAndOne().map((item) =>
            item.key === workKey(3)
                ? { ...item, section: 'works' as const, pinned: false, pinOrder: null }
                : item,
        );
        saveAction.mockResolvedValue(savedResponse(released));

        renderEditor(sixPinsAndOne(), { meta: meta({ worksTotal: 4 }) });
        fireEvent.click(controlFor(workKey(3), 'app-launcher-pin'));
        await flushDebounce();

        expect(saveChanges(0)).toEqual([{ key: workKey(3), pinned: false }]);
        expect(screen.getByTestId('app-launcher-pin-counter')).toHaveTextContent(
            '5 of 6 pins used',
        );
        expect(controlFor(workKey(4), 'app-launcher-pin')).not.toBeDisabled();
    });
});

// ---------------------------------------------------------------------------
// Reordering (FR-62, ACC-11-47)
// ---------------------------------------------------------------------------

describe('AppLauncherSettings — reordering writes the whole section (FR-62, ACC-11-47)', () => {
    const works = [workItem(1), workItem(2), workItem(3)];

    it('writes an explicit order for every row of the section a Move up moves within', async () => {
        // The server numbers a tile's `order` inside its section, so the
        // three Works arrive as 0, 1, 2 (plan §4.2:420-432).
        const numbered = works.map((item, index) => ({ ...item, order: index }));
        saveAction.mockImplementation(async (changes) =>
            savedResponse(applyChanges(numbered, changes)),
        );

        renderEditor(numbered, { meta: meta({ worksTotal: 3 }) });
        fireEvent.click(controlFor(workKey(2), 'app-launcher-move-up'));
        await flushDebounce();

        const changes = saveChanges(0);
        expect(changes).not.toBeNull();
        // Every row of the section, each with its new position — the second
        // Work swapped with the first, and the third keeps index 2.
        expect([...(changes ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))).toEqual([
            { key: workKey(2), order: 0 },
            { key: workKey(1), order: 1 },
            { key: workKey(3), order: 2 },
        ]);
    });

    it('moves with Alt+ArrowUp and Alt+ArrowDown from the row itself', async () => {
        const numbered = works.map((item, index) => ({ ...item, order: index }));
        saveAction.mockImplementation(async (changes) =>
            savedResponse(applyChanges(numbered, changes)),
        );
        renderEditor(numbered, { meta: meta({ worksTotal: 3 }) });

        fireEvent.keyDown(rowFor(workKey(3)), { key: 'ArrowUp', altKey: true });
        await flushDebounce();

        expect(orderedKeys(saveChanges(0) ?? [])).toEqual([workKey(1), workKey(3), workKey(2)]);

        // Alt+ArrowDown is the same primitive in the other direction.
        fireEvent.keyDown(rowFor(workKey(1)), { key: 'ArrowDown', altKey: true });
        await flushDebounce();

        expect(orderedKeys(saveChanges(1) ?? [])).toEqual([workKey(3), workKey(1), workKey(2)]);
    });

    it('ignores an arrow key without Alt, so the list does not move while scrolling', async () => {
        const numbered = works.map((item, index) => ({ ...item, order: index }));
        renderEditor(numbered, { meta: meta({ worksTotal: 3 }) });

        fireEvent.keyDown(rowFor(workKey(1)), { key: 'ArrowDown' });
        await flushDebounce();

        expect(saveAction).not.toHaveBeenCalled();
    });

    it('reorders from the native drag handle', async () => {
        const numbered = works.map((item, index) => ({ ...item, order: index }));
        saveAction.mockImplementation(async (changes) =>
            savedResponse(applyChanges(numbered, changes)),
        );
        renderEditor(numbered, { meta: meta({ worksTotal: 3 }) });

        fireEvent.dragStart(controlFor(workKey(1), 'app-launcher-drag'));
        fireEvent.dragOver(rowFor(workKey(3)));
        fireEvent.drop(rowFor(workKey(3)));
        await flushDebounce();

        expect(orderedKeys(saveChanges(0) ?? [])).toEqual([workKey(2), workKey(3), workKey(1)]);
    });

    it('never emits more changes than one save may carry (FR-28)', async () => {
        const many = Array.from({ length: 199 }, (_, index) => workItem(index + 1));
        saveAction.mockImplementation(async (changes) =>
            savedResponse(applyChanges(many, changes)),
        );
        renderEditor(many, { meta: meta({ worksTotal: 199 }) });

        fireEvent.click(controlFor(workKey(199), 'app-launcher-move-up'));
        await flushDebounce();

        expect(saveChanges(0)).toHaveLength(199);
    });
});

// ---------------------------------------------------------------------------
// Past 200 items (FR-63, ACC-11-47)
// ---------------------------------------------------------------------------

describe('AppLauncherSettings — past 200 eligible items (FR-63, ACC-11-47)', () => {
    /** One Ever app plus 204 Works: 205 eligible, and the response carries 200. */
    function truncatedFixture(): {
        items: AppLauncherItem[];
        meta: AppLauncherListResponse['meta'];
    } {
        const platform = platformItem('gauzy');
        const allWorks = Array.from({ length: 204 }, (_, index) => workItem(index + 1));
        const items = [platform, ...allWorks.slice(0, 199)];
        return { items, meta: meta({ worksTotal: 204, total: 205, truncated: true }) };
    }

    it('renders the counted line and the filter', () => {
        const { items, meta: pageMeta } = truncatedFixture();
        renderEditor(items, { meta: pageMeta });

        expect(screen.getByTestId('app-launcher-count')).toHaveTextContent('Showing 200 of 205');
        expect(screen.getByTestId('app-launcher-filter')).toHaveAccessibleName('Filter apps');
        expect(screen.getAllByTestId('app-launcher-row')).toHaveLength(200);
    });

    it('counts what the read REPORTED, not a number rebuilt from the rows it holds', () => {
        // `worksTotal` is Works only and the page holds one Ever app, so the old
        // reconstruction would render "Showing 200 of 205" here. Only
        // `meta.total` can produce 250.
        const items = [platformItem('gauzy'), workItem(1)];
        renderEditor(items, { meta: meta({ worksTotal: 204, total: 250, truncated: true }) });

        expect(screen.getByTestId('app-launcher-count')).toHaveTextContent('Showing 200 of 250');
        expect(screen.getByTestId('app-launcher-count')).not.toHaveTextContent('205');
    });

    it('keeps every item it holds reachable: the filter narrows the view, never the list', () => {
        const { items, meta: pageMeta } = truncatedFixture();
        renderEditor(items, { meta: pageMeta });

        // A row that sorts last is still reachable — filtering by its name
        // renders it, and clearing the filter brings the whole page back.
        const lastKey = workKey(199);
        fireEvent.change(screen.getByTestId('app-launcher-filter'), {
            target: { value: 'Work 199' },
        });
        expect(screen.getAllByTestId('app-launcher-row')).toHaveLength(1);
        expect(rowFor(lastKey)).toBeInTheDocument();

        fireEvent.change(screen.getByTestId('app-launcher-filter'), {
            target: { value: 'Work 2' },
        });
        // "Work 2" matches Work 2 and the 2x/20x family — a substring filter,
        // so nothing the person typed is dropped behind the 200-item cap.
        expect(screen.getAllByTestId('app-launcher-row').length).toBeGreaterThan(1);

        fireEvent.change(screen.getByTestId('app-launcher-filter'), { target: { value: '' } });
        expect(screen.getAllByTestId('app-launcher-row')).toHaveLength(200);
    });

    it('reaches an item past the cap: the filter is sent to the server and its rows are rendered', async () => {
        const { items, meta: pageMeta } = truncatedFixture();
        // The 240th Work is not in the 200 rows the page holds…
        const beyond = workItem(240, { name: 'Work 240' });
        expect(items.map((item) => item.key)).not.toContain(beyond.key);
        readAction.mockResolvedValue(
            listedResponse([beyond], { worksTotal: 204, total: 250, truncated: true }),
        );

        renderEditor(items, { meta: pageMeta });
        fireEvent.change(screen.getByTestId('app-launcher-filter'), {
            target: { value: 'Work 240' },
        });
        await flushFilterDebounce();

        // …and the read that names it is what makes it reachable (FR-63).
        expect(readAction).toHaveBeenCalledTimes(1);
        expect(readAction).toHaveBeenCalledWith('Work 240');
        expect(rowFor(beyond.key)).toBeInTheDocument();
        expect(screen.getAllByTestId('app-launcher-row')).toHaveLength(1);
        // The count is the eligible total the read reported, before the filter.
        expect(screen.getByTestId('app-launcher-count')).toHaveTextContent('Showing 200 of 250');
    });

    it('asks the server on its own debounce — never on the save window (FR-28, FR-63)', async () => {
        const { items, meta: pageMeta } = truncatedFixture();
        renderEditor(items, { meta: pageMeta });

        expect(saveAction).not.toHaveBeenCalled();
        fireEvent.change(screen.getByTestId('app-launcher-filter'), {
            target: { value: 'Work 240' },
        });

        // The filter is a read: it must not wait for the save's half-second.
        expect(FILTER_DEBOUNCE_MS).toBeLessThan(SAVE_DEBOUNCE_MS);
        await flushFilterDebounce();
        expect(readAction).toHaveBeenCalledTimes(1);
        expect(saveAction, 'a filter never saves anything').not.toHaveBeenCalled();

        // Clearing the filter asks again, so the page goes back to the read's own
        // unfiltered answer instead of keeping a filtered list.
        fireEvent.change(screen.getByTestId('app-launcher-filter'), { target: { value: '' } });
        await flushFilterDebounce();
        expect(readAction).toHaveBeenCalledTimes(2);
        expect(readAction).toHaveBeenLastCalledWith('');
        // Nothing is fetched until the window closes: a second keystroke inside it
        // restarts the window rather than opening a second read.
        expect(screen.getAllByTestId('app-launcher-row')).toHaveLength(200);
    });

    it('coalesces keystrokes inside the window into one read', async () => {
        const { items, meta: pageMeta } = truncatedFixture();
        renderEditor(items, { meta: pageMeta });

        const input = screen.getByTestId('app-launcher-filter');
        fireEvent.change(input, { target: { value: 'W' } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(FILTER_DEBOUNCE_MS - 50);
        });
        expect(readAction).not.toHaveBeenCalled();

        fireEvent.change(input, { target: { value: 'Wo' } });
        await flushFilterDebounce();

        expect(readAction).toHaveBeenCalledTimes(1);
        expect(readAction).toHaveBeenCalledWith('Wo');
    });

    it('narrows case- and accent-insensitively, the same fold the server applies', () => {
        const cafe = workItem(1, { name: 'Café Central' });
        renderEditor([cafe, workItem(2)], {
            meta: meta({ worksTotal: 2, total: 300, truncated: true }),
        });

        fireEvent.change(screen.getByTestId('app-launcher-filter'), { target: { value: 'CAFE' } });

        expect(screen.getAllByTestId('app-launcher-row')).toHaveLength(1);
        expect(rowFor(cafe.key)).toBeInTheDocument();
    });

    it('keeps the local narrowing and says so when the filtered read fails', async () => {
        const { items, meta: pageMeta } = truncatedFixture();
        readAction.mockResolvedValue({ success: false, data: null, error: 'failed_to_load_apps' });

        renderEditor(items, { meta: pageMeta });
        fireEvent.change(screen.getByTestId('app-launcher-filter'), {
            target: { value: 'Work 199' },
        });
        await flushFilterDebounce();

        // The read failed, so a row past the cap cannot be reached — but the rows
        // the page holds are still filtered, and the failure is not silent.
        expect(rowFor(workKey(199))).toBeInTheDocument();
        expect(screen.getByTestId('app-launcher-filter-error')).toHaveTextContent(
            "Your apps couldn't be loaded.",
        );

        // A later read that succeeds clears the message.
        readAction.mockResolvedValue(listedResponse([], { total: 205, truncated: true }));
        fireEvent.change(screen.getByTestId('app-launcher-filter'), {
            target: { value: 'Work 200' },
        });
        await flushFilterDebounce();

        expect(screen.queryByTestId('app-launcher-filter-error')).toBeNull();
    });

    it('does not claim a cap when the whole eligible set fits', () => {
        renderEditor([platformItem('gauzy'), workItem(1)], { meta: meta({ worksTotal: 1 }) });

        expect(screen.queryByTestId('app-launcher-count')).toBeNull();
        expect(screen.queryByTestId('app-launcher-filter')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// The pinned section (FR-62's merged view)
// ---------------------------------------------------------------------------

describe('AppLauncherSettings — reordering the pinned section (FR-62)', () => {
    it('re-pins the section in the new sequence, because pin order is what the panel renders', async () => {
        const pinnedItems = [
            platformItem('gauzy', { section: 'pinned', pinned: true, pinOrder: 0 }),
            platformItem('cal', { section: 'pinned', pinned: true, pinOrder: 1 }),
            workItem(1, { section: 'pinned', pinned: true, pinOrder: 2 }),
        ];
        saveAction.mockImplementation(async (changes) =>
            savedResponse(applyChanges(pinnedItems, changes)),
        );
        renderEditor(pinnedItems, { meta: meta({ worksTotal: 1 }) });

        fireEvent.click(controlFor('platform:cal', 'app-launcher-move-up'));
        await flushDebounce();

        const changes = saveChanges(0) ?? [];
        // FR-62: `order` for every item of the section it moves within …
        expect(orderedKeys(changes)).toEqual(['platform:cal', 'platform:gauzy', workKey(1)]);
        // … and the pin sequence, which is the only thing the panel sorts a
        // pinned tile by, carries the same arrangement.
        const pins = changes.filter((change) => change.pinned !== undefined);
        // The release half is asserted as a SET: the API removes each released
        // key from the merged pinned sequence by identity before it appends the
        // re-pins (`nextPinnedSequence`), so the order they are listed in
        // carries no meaning — what matters is that all three were released.
        expect(
            pins
                .filter((change) => change.pinned === false)
                .map((change) => change.key)
                .sort(),
        ).toEqual(['platform:cal', 'platform:gauzy', workKey(1)].sort());
        expect(pins.filter((change) => change.pinned === true).map((change) => change.key)).toEqual(
            ['platform:cal', 'platform:gauzy', workKey(1)],
        );
    });
});
