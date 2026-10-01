'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
    APP_LAUNCHER_MAX_CHANGES_PER_SAVE,
    APP_LAUNCHER_PIN_LIMIT,
    type AppLauncherItem,
    type AppLauncherListResponse,
    type AppLauncherPreferenceChange,
    type AppLauncherSection,
} from '@ever-works/contracts';
import {
    readAppLauncherListAction,
    saveAppLauncherPreferencesAction,
} from '@/app/actions/settings/app-launcher';
import { foldText } from '@/components/command-palette/registry/local-match';
import { useWorkspaceScope } from '@/lib/hooks/use-workspace-scope';

/**
 * APW-11 T16 — **Manage apps**: the App Launcher's settings editor
 * (`/settings/app-launcher`, plan §7, spec FR-27, FR-28, FR-38, FR-41, FR-62,
 * FR-63).
 *
 * The page (`app/[locale]/(dashboard)/settings/app-launcher/page.tsx`) reads the
 * registry with `includeHidden=true` on the server and hands the list here. The
 * editor is a client component because every control on it is an edit that must
 * survive on another device — which is the whole point of the page.
 *
 * ## The three rules this file exists to get right
 *
 * 1. **One save per batch, 500 ms after the last change** (FR-28, plan §4.2).
 *    {@link AppLauncherSettings.SAVE_DEBOUNCE_MS} is the window; a second change
 *    inside it restarts the window rather than opening a second save, so a
 *    person toggling six switches makes one request. The pending state is a
 *    **map keyed by item**, not a queue: two changes to the same tile merge into
 *    one merge-patch entry, which is exactly the semantics the API implements
 *    (`projectPreferenceRows`).
 * 2. **A reorder writes `order` for every item of the section it moves within**
 *    (FR-62). Moving one row and sending only that row's index would leave the
 *    rest on their fallback order, so the arrangement would not survive a
 *    reload — the failure the rule exists to prevent. The editor therefore
 *    stores the section's **target sequence**, and materialises it into one
 *    `{ key, order }` per row at flush time
 *    ({@link AppLauncherSettings.buildChanges}).
 * 3. **Nothing is silently hidden** (FR-63). The list is the server's, capped at
 *    200; the header counts the eligible set the read reported — `meta.total`,
 *    never a number rebuilt from the rows in hand — and the filter narrows **the
 *    view** without ever dropping a row from the list, so clearing it restores
 *    every item the page holds. The filter is also **sent to the server** on its
 *    own short debounce ({@link AppLauncherSettings.FILTER_DEBOUNCE_MS}): a
 *    client-side filter can only narrow the 200 rows the page already has, so
 *    the 240th of 250 eligible items could never be reached, and the whole point
 *    of FR-63's filter is that it can be. The rows a filtered read returns are
 *    merged into the list, which is how an item past the cap becomes editable
 *    here at all.
 *
 * ## Pinned rows are reordered through the pin sequence
 *
 * FR-62 says a reorder writes `order` for every item of the section it moves
 * within, and the panel sorts a pinned tile by `pinOrder` — a *view* fact the
 * API recomputes from the resulting pinned sequence inside the save's
 * transaction. Writing `order` for the pinned section alone would therefore
 * change nothing a person could see. So a move inside **Pinned** writes the
 * section's whole `order` (the rule, verbatim) *and* re-pins the section in the
 * new sequence (`pinned: false` for the current pins, then `pinned: true` in
 * the target order) — the only representation the api accepts for "this pin is
 * now first" (plan §4.2:429-432). The two sets are emitted in one save, so the
 * release and the re-pin land in one transaction and a failure cannot leave the
 * person with fewer pins than they had.
 *
 * ## What the editor does not do
 *
 * It does not hide the current platform (the API refuses `visible: false` for
 * `platform:<selfId>` with `cannotHideCurrent`, so the control is offered
 * disabled), and it does not let a Work's own exposure switch be overridden from
 * here (FR-59 — that choice belongs to the Work, and the row says so).
 */

/** FR-28 / plan §4.2: the debounce window before a batch is sent. */
export const SAVE_DEBOUNCE_MS = 500;

/**
 * FR-63: the window before the filter is sent to the server.
 *
 * Deliberately **its own** number and deliberately shorter than
 * {@link SAVE_DEBOUNCE_MS}: the filter is a **read**, and borrowing the save's
 * half-second would make typing feel like a save that has not happened yet —
 * while a write and a read sharing one timer would also mean a keystroke could
 * postpone a pending arrangement save. Long enough to coalesce a burst of
 * keystrokes into one request, short enough that the list still feels live.
 */
export const FILTER_DEBOUNCE_MS = 250;

/** The three sections the API orders a list into (plan §4.2:420-435). */
const SECTION_ORDER: ReadonlyArray<AppLauncherSection> = ['pinned', 'platforms', 'works'];

/** Where a save is, from the person's point of view (plan §8's save states). */
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface AppLauncherSettingsProps {
    /** The `includeHidden=true` list the page read — every eligible row (FR-27). */
    initialItems: AppLauncherItem[];
    /**
     * `meta` of the same read. `pinLimit`, `worksTotal` and `truncated` drive
     * FR-25's counter and FR-63's counted line; a preference save cannot change
     * them (eligibility is not a preference), so they are not re-read per save.
     */
    initialMeta: AppLauncherListResponse['meta'];
    /** `true` when the page's own read failed, so the editor renders that instead. */
    loadFailed?: boolean;
}

/** One section's rows, in the order the server put them in. */
interface SectionRows {
    section: AppLauncherSection;
    rows: AppLauncherItem[];
}

/** Split `values` into chunks no longer than `size`, preserving order. */
function chunk<T>(values: ReadonlyArray<T>, size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < values.length; index += size) {
        chunks.push(values.slice(index, index + size));
    }
    return chunks;
}

/**
 * The sequence `keys` takes when the item at `from` is dropped at `to`.
 *
 * Both indices are clamped into range, so **Move up** on the first row and
 * **Move down** on the last are no-ops that still write the whole section: the
 * editor is not asking the person to know they are at an edge (the same
 * clamping `reorderSection` in `@ever-works/agent` documents for the API side).
 */
export function reorderKeys(keys: ReadonlyArray<string>, from: number, to: number): string[] {
    const next = [...keys];
    if (next.length === 0) return next;
    const clamp = (value: number): number => Math.min(Math.max(value, 0), next.length - 1);
    const source = clamp(from);
    const target = clamp(to);
    const [moved] = next.splice(source, 1);
    next.splice(target, 0, moved);
    return next;
}

/**
 * Put `rows` back into `items` at the positions the section already occupies, so
 * an optimistic reorder moves the section's rows and leaves every other row
 * exactly where it was.
 */
function withSectionRows(
    items: AppLauncherItem[],
    section: AppLauncherSection,
    rows: AppLauncherItem[],
): AppLauncherItem[] {
    const next = [...items];
    let cursor = 0;
    for (let index = 0; index < next.length; index += 1) {
        if (next[index].section !== section) continue;
        if (cursor < rows.length) {
            next[index] = rows[cursor];
        }
        cursor += 1;
    }
    return next;
}

/**
 * The rows the page holds, with the rows a filtered read returned folded in
 * (FR-63).
 *
 * The editor's list only ever **grows**: a filtered read is what makes an item
 * past the 200-item cap reachable, and replacing the list with its answer would
 * throw away the 200 rows the page already had — clearing the filter would then
 * show one row instead of the page. So a row the page already holds is refreshed
 * from the server's copy, and a row it did not hold is inserted at the position
 * the server's own ordering gives it (the response is ordered by section, so a
 * new row lands inside its section and not at the end of the table).
 */
function mergeRows(held: AppLauncherItem[], incoming: AppLauncherItem[]): AppLauncherItem[] {
    if (incoming.length === 0) return held;

    const positionInAnswer = new Map(incoming.map((row, index) => [row.key, index]));
    const serverCopy = new Map(incoming.map((row) => [row.key, row]));
    const merged = held.map((row) => serverCopy.get(row.key) ?? row);
    const heldKeys = new Set(held.map((row) => row.key));

    for (const row of incoming) {
        if (heldKeys.has(row.key)) continue;
        const at = positionInAnswer.get(row.key) ?? Number.MAX_SAFE_INTEGER;
        const before = merged.findIndex(
            (existing) => (positionInAnswer.get(existing.key) ?? Number.MAX_SAFE_INTEGER) > at,
        );
        if (before < 0) {
            merged.push(row);
        } else {
            merged.splice(before, 0, row);
        }
    }

    return merged;
}

export function AppLauncherSettings({
    initialItems,
    initialMeta,
    loadFailed = false,
}: AppLauncherSettingsProps) {
    const t = useTranslations('dashboard.settings.appLauncher');
    /**
     * The panel's own block, for the two strings that are not this page's to
     * redefine: the section the launcher calls **Pinned**, and the empty-state
     * sentence. They already exist (T14) and re-stating them under a second key
     * would let the two surfaces drift apart.
     */
    const tLauncher = useTranslations('dashboard.appLauncher');
    const scope = useWorkspaceScope();

    const [items, setItems] = useState<AppLauncherItem[]>(initialItems);
    const [filter, setFilter] = useState('');
    /**
     * FR-63's `{count}` — the eligible count the read **reported**
     * (`meta.total`), counted before the cap and before the filter.
     *
     * It is state because a filtered read answers with the same number and the
     * page takes the freshest one; it is seeded from the page's own read so the
     * line is exact on first paint. Deliberately not rebuilt from the rows: with
     * 200 of 250 items in hand, `worksTotal + platform rows` is a guess, and a
     * count line that guesses is the one thing FR-63's counted line must not be.
     */
    const [eligibleTotal, setEligibleTotal] = useState(initialMeta.total);
    /** `true` when a filtered read failed, so the shortage is not silent. */
    const [filterFailed, setFilterFailed] = useState(false);
    const [saveState, setSaveState] = useState<SaveState>('idle');
    /** Bumped by every queued change; the effect below owns the debounce timer. */
    const [queueToken, setQueueToken] = useState(0);

    /** Merge patches by item key — `visible`, `pinned`, and single-row `order`. */
    const patchesRef = useRef(new Map<string, AppLauncherPreferenceChange>());
    /** Section → the sequence its rows now have, materialised at flush time. */
    const sequencesRef = useRef(new Map<AppLauncherSection, string[]>());
    /**
     * Did a pending move change the **pin order**?
     *
     * Only the move itself can answer this: once the optimistic reorder has run,
     * the rows are already in the target order, so comparing them back to the
     * target would always match — and the release/re-pin pair that carries the
     * new ranking would never be written.
     */
    const pinnedReorderedRef = useRef(false);
    /** The rows as rendered, for the flush that runs outside a render. */
    const itemsRef = useRef<AppLauncherItem[]>(items);
    /** The row a native drag started on. */
    const draggingRef = useRef<string | null>(null);
    /** The needle the server was last asked for — `''` is the page's own read. */
    const requestedFilterRef = useRef('');
    /** The newest read's number, so a slower earlier answer cannot win. */
    const readSequenceRef = useRef(0);

    useEffect(() => {
        itemsRef.current = items;
    }, [items]);

    const pinLimit = initialMeta.pinLimit ?? APP_LAUNCHER_PIN_LIMIT;
    const pinned = useMemo(() => items.filter((item) => item.pinned), [items]);
    const pinCount = pinned.length;
    const pinBudgetSpent = pinCount >= pinLimit;

    /**
     * FR-63's counted line and filter, from the read the page made.
     *
     * `truncated` comes from that first, unfiltered read — not from the latest
     * one: a filtered read that answers three rows is not truncated, and taking
     * its flag would make the count line and the filter box disappear the moment
     * the person used them. `eligibleTotal` is `meta.total`, the eligible count
     * before any filter, so the line keeps saying **Showing 200 of {count}**
     * while the view is narrowed.
     */
    const truncated = initialMeta.truncated === true;

    const sections = useMemo<SectionRows[]>(
        () =>
            SECTION_ORDER.map((section) => ({
                section,
                rows: items.filter((item) => item.section === section),
            })).filter((entry) => entry.rows.length > 0),
        [items],
    );

    /**
     * The rows the filter shows **now**, while the server is still being asked.
     *
     * The same fold the registry applies (`foldText`,
     * `command-palette/registry/local-match.ts:10-18`, which
     * `packages/agent/src/app-launcher/launcher-filter.ts` mirrors), so the
     * browser never hides a row the server just matched: narrowing with a plain
     * `toLowerCase()` would drop **Café Central** from the answer to `cafe`.
     * This local narrowing is also why clearing the filter is instant — the list
     * itself is never narrowed, only the view.
     */
    const visibleSections = useMemo<SectionRows[]>(() => {
        const needle = foldText(filter);
        if (needle.length === 0) return sections;
        return sections
            .map((entry) => ({
                section: entry.section,
                rows: entry.rows.filter((row) => foldText(row.name).includes(needle)),
            }))
            .filter((entry) => entry.rows.length > 0);
    }, [filter, sections]);

    /**
     * Ask the server for the filter (FR-63).
     *
     * The answer is **merged** into the list rather than replacing it: the rows
     * it adds are the ones the 200-item cap left out, and the rows it repeats are
     * the page's own (see {@link mergeRows}). A failed read leaves the page with
     * what it holds and says so, because the alternative — silently pretending
     * the list is complete — is exactly the unreachability FR-63 exists to
     * remove.
     */
    const readFiltered = useCallback(async (needle: string): Promise<void> => {
        const sequence = (readSequenceRef.current += 1);
        const result = await readAppLauncherListAction(needle);
        // A slower earlier answer must not overwrite a newer one.
        if (sequence !== readSequenceRef.current) return;
        if (!result || result.success !== true) {
            setFilterFailed(true);
            return;
        }
        setFilterFailed(false);
        setEligibleTotal(result.data.meta.total);
        setItems((rows) => mergeRows(rows, result.data.items));
    }, []);

    useEffect(() => {
        // The page's own read already answered for `''`.
        if (filter === requestedFilterRef.current) return;
        const timer = setTimeout(() => {
            requestedFilterRef.current = filter;
            void readFiltered(filter);
        }, FILTER_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [filter, readFiltered]);

    // -----------------------------------------------------------------------
    // Queuing and flushing (FR-28)
    // -----------------------------------------------------------------------

    /** Record one merge patch and (re)start the 500 ms window. */
    const queue = useCallback((change: AppLauncherPreferenceChange) => {
        const previous = patchesRef.current.get(change.key);
        patchesRef.current.set(change.key, previous ? { ...previous, ...change } : change);
        // A queued change means a save is coming: `Saving…` covers the window
        // AND the request, so the person sees one continuous state.
        setSaveState('saving');
        setQueueToken((token) => token + 1);
    }, []);

    /**
     * The change list of the whole pending window (FR-62).
     *
     * Order matters twice over: the API applies a merge patch per entry in the
     * order it receives them, and `nextPinnedSequence` walks the same list to
     * rebuild the pinned ranking — so every release precedes every re-pin.
     */
    const buildChanges = useCallback((rows: AppLauncherItem[]): AppLauncherPreferenceChange[] => {
        const changes: AppLauncherPreferenceChange[] = [];
        const sequences = sequencesRef.current;

        // 1. Every moved section, `order` for every row of it.
        for (const [section, sequence] of sequences) {
            sequence.forEach((key, index) => changes.push({ key, order: index }));
        }

        // 2. A moved pinned section also carries the new pin sequence: released
        //    first, then re-pinned in the target order (FR-62's merged view).
        const pinnedSequence = sequences.get('pinned');
        if (pinnedSequence !== undefined && pinnedReorderedRef.current) {
            const current = rows.filter((row) => row.pinned).map((row) => row.key);
            for (const key of current) changes.push({ key, pinned: false });
            for (const key of pinnedSequence) changes.push({ key, pinned: true });
        }

        // 3. The person's switches.
        for (const patch of patchesRef.current.values()) changes.push(patch);

        return changes;
    }, []);

    const flush = useCallback(async () => {
        const changes = buildChanges(itemsRef.current);
        if (changes.length === 0) return;
        // Snapshot before clearing: a failed save puts the pending intent back
        // exactly as it was — including the release/re-pin pair, which a
        // per-key merge could not rebuild — so the person's next action
        // re-sends it instead of silently losing the arrangement.
        const patchSnapshot = new Map(patchesRef.current);
        const sequenceSnapshot = new Map(sequencesRef.current);
        const pinnedSnapshot = pinnedReorderedRef.current;
        patchesRef.current.clear();
        sequencesRef.current.clear();
        pinnedReorderedRef.current = false;

        const restore = (): void => {
            patchesRef.current = patchSnapshot;
            sequencesRef.current = sequenceSnapshot;
            pinnedReorderedRef.current = pinnedSnapshot;
            setSaveState('error');
        };

        try {
            // A save carries at most 200 changes (FR-28). One reorder can reach
            // that on its own — a 200-row section writes 200 orders — so a
            // window that also holds a switch is split rather than truncated:
            // dropping an item's `order` is the bug FR-62 guards against.
            //
            // Two windows may overlap (a change queued while a save is still in
            // flight fires its own timer), and that is safe rather than guarded:
            // the API resolves concurrent saves last-write-wins **per item**
            // (FR-29, `upsertMany`), and each response re-renders the editor with
            // the list the API actually holds.
            let rows = itemsRef.current;
            for (const batch of chunk(changes, APP_LAUNCHER_MAX_CHANGES_PER_SAVE)) {
                const result = await saveAppLauncherPreferencesAction(batch);
                if (!result.success) {
                    restore();
                    return;
                }
                // The response IS the refreshed list (plan §4.2:437-438).
                rows = result.data.items;
                setItems(result.data.items);
            }
            itemsRef.current = rows;
            setSaveState('saved');
        } catch {
            restore();
        }
    }, [buildChanges]);

    useEffect(() => {
        if (queueToken === 0) return;
        if (patchesRef.current.size === 0 && sequencesRef.current.size === 0) return;
        const timer = setTimeout(() => {
            void flush();
        }, SAVE_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [queueToken, flush]);

    // -----------------------------------------------------------------------
    // The edits
    // -----------------------------------------------------------------------

    const setVisible = useCallback(
        (item: AppLauncherItem, next: boolean) => {
            setItems((rows) =>
                rows.map((row) => (row.key === item.key ? { ...row, visible: next } : row)),
            );
            queue({ key: item.key, visible: next });
        },
        [queue],
    );

    const setPinned = useCallback(
        (item: AppLauncherItem, next: boolean) => {
            if (next && item.pinned === false && pinBudgetSpent) return;
            setItems((rows) =>
                rows.map((row) => (row.key === item.key ? { ...row, pinned: next } : row)),
            );
            queue({ key: item.key, pinned: next });
        },
        [pinBudgetSpent, queue],
    );

    /**
     * Move one row to a position inside its own section, and record the whole
     * section's new sequence (FR-62). The optimistic reorder moves the section's
     * rows only — every other section keeps its place.
     */
    const moveRowTo = useCallback((section: AppLauncherSection, key: string, target: number) => {
        const rows = itemsRef.current;
        const keys = rows.filter((row) => row.section === section).map((row) => row.key);
        const from = keys.indexOf(key);
        if (from < 0) return;
        const nextKeys = reorderKeys(keys, from, target);
        if (nextKeys.join('\u0000') === keys.join('\u0000')) {
            // An edge move is still a reorder of the section (FR-62 writes
            // every row), but the person sees no change, so no pin churn.
            sequencesRef.current.set(section, nextKeys);
            setSaveState('saving');
            setQueueToken((token) => token + 1);
            return;
        }

        const byKey = new Map(rows.map((row) => [row.key, row]));
        const reordered = nextKeys.map((nextKey, index) => {
            const row = byKey.get(nextKey) as AppLauncherItem;
            return { ...row, order: index };
        });
        const next = withSectionRows(rows, section, reordered);
        itemsRef.current = next;
        setItems(next);
        sequencesRef.current.set(section, nextKeys);
        if (section === 'pinned') pinnedReorderedRef.current = true;
        setSaveState('saving');
        setQueueToken((token) => token + 1);
    }, []);

    const moveBy = useCallback(
        (section: AppLauncherSection, key: string, delta: number) => {
            const keys = itemsRef.current
                .filter((row) => row.section === section)
                .map((row) => row.key);
            const from = keys.indexOf(key);
            if (from < 0) return;
            moveRowTo(section, key, from + delta);
        },
        [moveRowTo],
    );

    // -----------------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------------

    const sectionHeading = useCallback(
        (section: AppLauncherSection): string => {
            if (section === 'pinned') return tLauncher('sectionPinned');
            if (section === 'platforms') return t('sectionPlatforms');
            return scope?.kind === 'organization'
                ? t('worksHeadingOrg', { organization: scope.slug })
                : t('worksHeadingPersonal');
        },
        [scope, t, tLauncher],
    );

    const saveStateCopy =
        saveState === 'saving'
            ? t('saving')
            : saveState === 'saved'
              ? t('saved')
              : saveState === 'error'
                ? t('saveFailed')
                : '';

    if (loadFailed) {
        return (
            <div data-testid="app-launcher-settings">
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('intro')}</p>
                <p
                    role="alert"
                    data-testid="app-launcher-load-error"
                    className="mt-4 rounded-lg border border-border px-4 py-3 text-sm text-text-secondary dark:border-border-dark dark:text-text-secondary-dark"
                >
                    {tLauncher('worksError')}
                </p>
            </div>
        );
    }

    return (
        <div data-testid="app-launcher-settings" className="space-y-4">
            <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('intro')}</p>

            <div className="flex flex-wrap items-center justify-between gap-3">
                <p
                    data-testid="app-launcher-pin-counter"
                    className="text-sm text-text-secondary dark:text-text-secondary-dark"
                >
                    {t('pinCounter', { count: pinCount })}
                </p>
                <p
                    data-testid="app-launcher-save-state"
                    role={saveState === 'error' ? 'alert' : 'status'}
                    aria-live="polite"
                    className="text-sm text-text-muted dark:text-text-muted-dark"
                >
                    {saveStateCopy}
                </p>
            </div>

            {truncated ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-2 dark:border-border-dark">
                    <p
                        data-testid="app-launcher-count"
                        className="text-sm text-text-secondary dark:text-text-secondary-dark"
                    >
                        {t('showingCount', { count: eligibleTotal })}
                    </p>
                    <input
                        type="search"
                        data-testid="app-launcher-filter"
                        aria-label={t('filter')}
                        placeholder={t('filter')}
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                        className="w-48 rounded-md border border-border bg-surface px-2 py-1 text-sm text-text dark:border-border-dark dark:bg-surface-dark dark:text-text-dark"
                    />
                </div>
            ) : null}

            {/*
              A failed filtered read is never silent: the rows past the cap are
              unreachable again while it is failing, and the person is looking at
              a list that cannot show them why. The sentence is the launcher's own
              read-failure copy (T14's `worksError`) rather than a second string
              that says the same thing.
            */}
            {truncated && filterFailed ? (
                <p
                    role="status"
                    data-testid="app-launcher-filter-error"
                    className="text-sm text-text-muted dark:text-text-muted-dark"
                >
                    {tLauncher('worksError')}
                </p>
            ) : null}

            {items.length === 0 ? (
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    {tLauncher('emptyWorks')}
                </p>
            ) : (
                <table className="w-full border-collapse text-sm">
                    <thead>
                        <tr className="text-left text-xs uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                            <th scope="col" className="py-2" />
                            <th scope="col" className="w-16 py-2">
                                {t('columnShow')}
                            </th>
                            <th scope="col" className="w-16 py-2">
                                {t('columnPin')}
                            </th>
                            <th scope="col" className="w-24 py-2" />
                        </tr>
                    </thead>
                    {visibleSections.map(({ section, rows }) => (
                        <tbody
                            key={section}
                            data-testid="app-launcher-section"
                            data-section={section}
                        >
                            <tr>
                                <th
                                    scope="colgroup"
                                    colSpan={4}
                                    className="pt-4 pb-1 text-left text-xs font-medium uppercase tracking-wider text-text-muted dark:text-text-muted-dark"
                                >
                                    {sectionHeading(section)}
                                </th>
                            </tr>
                            {rows.map((item, index) => {
                                const showDisabled =
                                    item.manageState === 'exposureOff' || item.current === true;
                                const showTitle =
                                    item.manageState === 'exposureOff'
                                        ? t('exposureOffAction')
                                        : item.current === true
                                          ? tLauncher('chipCurrent')
                                          : undefined;
                                const rowPinDisabled = !item.pinned && pinBudgetSpent;

                                return (
                                    <tr
                                        key={item.key}
                                        data-testid="app-launcher-row"
                                        data-item-key={item.key}
                                        data-section={item.section}
                                        tabIndex={0}
                                        onKeyDown={(event) => {
                                            if (!event.altKey) return;
                                            if (event.key === 'ArrowUp') {
                                                event.preventDefault();
                                                moveBy(section, item.key, -1);
                                            } else if (event.key === 'ArrowDown') {
                                                event.preventDefault();
                                                moveBy(section, item.key, 1);
                                            }
                                        }}
                                        onDragOver={(event) => {
                                            if (draggingRef.current !== null) {
                                                event.preventDefault();
                                            }
                                        }}
                                        onDrop={(event) => {
                                            const dragged = draggingRef.current;
                                            draggingRef.current = null;
                                            if (dragged === null || dragged === item.key) return;
                                            event.preventDefault();
                                            moveRowTo(section, dragged, index);
                                        }}
                                        className="border-t border-border dark:border-border-dark"
                                    >
                                        <td className="py-2">
                                            <span className="flex items-center gap-2">
                                                <span
                                                    draggable
                                                    role="button"
                                                    tabIndex={-1}
                                                    data-testid="app-launcher-drag"
                                                    aria-label={t('dragHandleLabel', {
                                                        name: item.name,
                                                    })}
                                                    title={t('dragHandleLabel', {
                                                        name: item.name,
                                                    })}
                                                    onDragStart={() => {
                                                        draggingRef.current = item.key;
                                                    }}
                                                    onDragEnd={() => {
                                                        draggingRef.current = null;
                                                    }}
                                                    className="cursor-grab select-none px-1 text-text-muted dark:text-text-muted-dark"
                                                >
                                                    ⠿
                                                </span>
                                                <span className="text-text dark:text-text-dark">
                                                    {item.name}
                                                </span>
                                                {item.manageState === 'notLive' ? (
                                                    <span
                                                        data-testid="app-launcher-not-live"
                                                        title={t('notLive')}
                                                        className="rounded bg-surface-secondary px-1.5 py-0.5 text-xs text-text-muted dark:bg-surface-secondary-dark dark:text-text-muted-dark"
                                                    >
                                                        {t('notLive')}
                                                    </span>
                                                ) : null}
                                                {item.manageState === 'exposureOff' ? (
                                                    <span
                                                        data-testid="app-launcher-exposure-off"
                                                        title={t('exposureOffAction')}
                                                        className="rounded bg-surface-secondary px-1.5 py-0.5 text-xs text-text-muted dark:bg-surface-secondary-dark dark:text-text-muted-dark"
                                                    >
                                                        {t('exposureOff')}
                                                    </span>
                                                ) : null}
                                            </span>
                                        </td>
                                        <td className="py-2">
                                            <input
                                                type="checkbox"
                                                data-testid="app-launcher-show"
                                                aria-label={t('showToggleLabel', {
                                                    name: item.name,
                                                })}
                                                checked={item.visible}
                                                disabled={showDisabled}
                                                title={showTitle}
                                                onChange={(event) =>
                                                    setVisible(item, event.target.checked)
                                                }
                                            />
                                        </td>
                                        <td className="py-2">
                                            <input
                                                type="checkbox"
                                                data-testid="app-launcher-pin"
                                                aria-label={t('pinToggleLabel', {
                                                    name: item.name,
                                                })}
                                                checked={item.pinned}
                                                disabled={rowPinDisabled}
                                                title={rowPinDisabled ? t('pinLimit') : undefined}
                                                onChange={(event) =>
                                                    setPinned(item, event.target.checked)
                                                }
                                            />
                                        </td>
                                        <td className="py-2">
                                            <span className="flex items-center gap-1">
                                                <button
                                                    type="button"
                                                    data-testid="app-launcher-move-up"
                                                    aria-label={t('moveUp')}
                                                    title={t('moveUp')}
                                                    disabled={index === 0}
                                                    onClick={() =>
                                                        moveRowTo(section, item.key, index - 1)
                                                    }
                                                    className="rounded px-1 text-text-muted hover:bg-surface-secondary disabled:opacity-40 dark:text-text-muted-dark dark:hover:bg-surface-secondary-dark"
                                                >
                                                    ↑
                                                </button>
                                                <button
                                                    type="button"
                                                    data-testid="app-launcher-move-down"
                                                    aria-label={t('moveDown')}
                                                    title={t('moveDown')}
                                                    disabled={index === rows.length - 1}
                                                    onClick={() =>
                                                        moveRowTo(section, item.key, index + 1)
                                                    }
                                                    className="rounded px-1 text-text-muted hover:bg-surface-secondary disabled:opacity-40 dark:text-text-muted-dark dark:hover:bg-surface-secondary-dark"
                                                >
                                                    ↓
                                                </button>
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    ))}
                </table>
            )}
        </div>
    );
}
