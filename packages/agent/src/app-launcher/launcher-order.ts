/**
 * APW-11 (App Launcher) — the pure ordering and pin model.
 *
 * Spec: FR-26 (`spec.md:289-290`), FR-4 (`spec.md:192-193`), FR-24/FR-25
 * (`spec.md:285-288`), FR-62 (`spec.md:298-302`) and FR-63 (`spec.md:303-305`);
 * plan `…/plan.md` §4.2 (plan.md:420-435) is the normative rule list and §10.1
 * (plan.md:939) names this module's test file.
 *
 * Nothing here reads the database or the environment: rows are handed in and a
 * rendering is handed back. That is what lets the three rules that are easiest
 * to get subtly wrong — the merged pinned view, the section caps, and the
 * fallback order — be asserted at their boundaries.
 *
 * ## The order (FR-26)
 *
 *   1. **Pinned** first, by `pinOrder`, then by pin time (`updatedAt`
 *      ascending), so the six the panel shows are the six pinned first
 *      (FR-62);
 *   2. then **Ever apps**, by the person's order, else the catalog's ordering
 *      number, else the name;
 *   3. then **Your apps**, by the person's order, else the most recent
 *      successful production deployment, newest first.
 *
 * The person's stored order is one sort key applied **before** the item's own
 * fallback, never interleaved with it: an item with no stored order sorts after
 * every item that has one.
 *
 * ## The merged pinned view (FR-62, plan §4.2:420-432)
 *
 * Ever app preferences live under the `global` scope and are shared by every
 * Organization; Work preferences live under `personal` or the active
 * Organization's id. The pinned set a read renders — and the set FR-25's
 * six-pin budget is counted over — is therefore `global ∪ <active scope>`,
 * which is what {@link mergeLauncherPreferences} builds. A pin made in
 * Organization B therefore never renumbers Organization A: A keeps its six and
 * renders the first six by pin order and pin time until one is released.
 *
 * ## The documented stable-order rule
 *
 * Every comparator here ends with the item's `key` (and, where a name exists,
 * with the name before it) so the result is a total order. Shuffling the input
 * array cannot change the rendering, which is what makes the panel's "tiles
 * never reorder while the panel is open" (FR-6) true across two responses
 * computed from the same rows. The rule is asserted by its own test rather than
 * left as a property of `Array.prototype.sort`'s implementation-defined
 * stability.
 *
 * ## The filter is applied before the cap (FR-63)
 *
 * `options.filter` narrows the **eligible** set here, and `limit` then applies
 * to what survives — never the other way round, because a filter applied after
 * the cap could only answer from the items the cap had already chosen, which is
 * precisely the "item 201 is unreachable" gap FR-63 exists to close. Filtering
 * removes whole items and never re-ranks the ones it keeps, so the FR-26 order
 * of a filtered response is the order of the unfiltered one (minus what the
 * needle excluded) and the section `order` numbers are recomputed over what is
 * left. {@link OrderLauncherItemsResult.total} carries the pre-filter,
 * pre-cap count the **Showing 200 of {count}** line renders.
 *
 * ## The numbers are imported, never restated
 *
 * Every cap below comes from `@ever-works/contracts` (`apps/app-launcher.ts`,
 * plan §3.3), which is the one place the panel, the API and the web action
 * agree on. Restating `6`, `12`, `24` or `200` here would be the first step
 * towards the panel and the save path disagreeing.
 */

import {
    APP_LAUNCHER_MAX_ITEMS_RESPONSE,
    APP_LAUNCHER_PANEL_PLATFORMS_MAX,
    APP_LAUNCHER_PANEL_WORKS_MAX,
    APP_LAUNCHER_PIN_LIMIT,
    appLauncherPinLimitExceeded,
    type AppLauncherItemKind,
    type AppLauncherManageState,
    type AppLauncherSection,
} from '@ever-works/contracts';
import { matchesLauncherFilter } from './launcher-filter';

/**
 * Plan §3.2:211 — the scope key Ever app rows are stored under. Every
 * Organization reads and writes the same row, which is spec FR-24's "values for
 * Ever apps are personal across Organizations".
 */
export const LAUNCHER_GLOBAL_SCOPE_KEY = 'global';

/**
 * Plan §3.2:211 — the scope key Work rows are stored under when no Organization
 * is active. Spec FR-24: values for Works are per scope, so this and each
 * organization id are separate buckets.
 */
export const LAUNCHER_PERSONAL_SCOPE_KEY = 'personal';

/**
 * One stored preference row, as `AppLauncherPreferenceRepository.findForUser`
 * returns it. Only `key` and `scopeKey` are required; an untouched field is
 * simply absent, so both are tolerated.
 */
export interface LauncherOrderPreference {
    /** `platform:<catalogId>` · `work:<uuid>`. */
    key: string;
    /** `'global'` · `'personal'` · `<organizationId>`. */
    scopeKey: string;
    visible?: boolean | null;
    pinned?: boolean | null;
    /** `0..5` while pinned; `null` means "pinned, position not yet computed". */
    pinOrder?: number | null;
    /** The stored `sortOrder` column, `0..9999`; `null` means "no explicit order". */
    sortOrder?: number | null;
    /** The pin-time tie-break (FR-62). */
    updatedAt?: Date | string | number | null;
}

/** One key's values after the merged view has been folded together. */
export interface MergedLauncherPreference {
    key: string;
    /** Spec FR-27 — absent everywhere means shown. */
    visible: boolean;
    pinned: boolean;
    pinOrder: number | null;
    /** Spec FR-26 — absent means the item's own fallback order. */
    order: number | null;
}

/** The minimum an item must expose to be ordered. */
export interface LauncherOrderableItem {
    key: string;
    kind: AppLauncherItemKind;
    /**
     * Ever apps only — the catalog entry's ordering number (FR-11,
     * `spec.md:219-221`). Ignored for Works.
     */
    catalogOrder?: number | null;
    /**
     * Works only — when the Work's most recent **successful** production
     * deployment landed (FR-26's "newest first", decided by
     * `findLatestReadyForWorks`). A Work that has never deployed has none and
     * sorts last.
     */
    readyAt?: Date | string | number | null;
    /** The final tie-break before `key`, so two same-second items are stable. */
    name?: string | null;
    /** Spec FR-27 — `false` only when a stored row says so. */
    visible?: boolean;
    /** Spec FR-56 — `'listed'` only when the item has a live address. */
    manageState?: AppLauncherManageState;
}

/** How one request wants the list rendered. */
export interface OrderLauncherItemsOptions {
    /**
     * The ACTIVE scope (plan §4.1:374): `'global'`, `'personal'`, or the active
     * Organization's id. The merged pinned view is this scope ∪ `global`.
     */
    scopeKey: string;
    /**
     * `true` = **Manage apps** (spec FR-27/FR-63): hidden and not-live items are
     * included and only the response cap applies. `false` (the default) = the
     * panel, where spec FR-4's section maxima apply and FR-56's not-live items
     * are dropped from the list while their preference rows are kept.
     */
    includeHidden?: boolean;
    /**
     * The response cap. Defaults to {@link APP_LAUNCHER_MAX_ITEMS_RESPONSE}
     * (FR-34, FR-63) and is never raised by this module.
     */
    limit?: number;
    /**
     * FR-63's filter, applied to the **eligible set before the cap** so an item
     * past `limit` is still reachable. A blank or whitespace-only filter is no
     * filter at all; matching is a case- and accent-insensitive substring test
     * on the item's name ({@link matchesLauncherFilter}).
     */
    filter?: string;
}

/** One ordered item, with the facts the tile needs that only ordering can decide. */
export interface LauncherOrderedItem<T extends LauncherOrderableItem> {
    item: T;
    key: string;
    kind: AppLauncherItemKind;
    /** Spec FR-2 — `pinned`, `platforms` or `works`. */
    section: AppLauncherSection;
    /** The merged view's answer (FR-24), not this scope's row alone. */
    visible: boolean;
    pinned: boolean;
    /** Position in the **merged** pinned view (FR-62), else `null`. */
    pinOrder: number | null;
    /** `0..n-1` inside `section`, in the order the list renders (plan.md:171). */
    order: number;
}

/** What {@link orderLauncherItems} returns. */
export interface OrderLauncherItemsResult<T extends LauncherOrderableItem> {
    items: LauncherOrderedItem<T>[];
    /**
     * Every eligible item in scope, counted **before** the filter and **before**
     * any cap, so FR-63's **Showing 200 of {count}** is a reported fact rather
     * than `items.length` — which, on a capped response, is the one number the
     * line must not be (ACC-11-47).
     */
    total: number;
    /**
     * Every eligible Work in scope, counted **before** the cap — so the panel
     * can render **View all {count}** from the same response that holds only
     * {@link APP_LAUNCHER_PANEL_WORKS_MAX} of them (ACC-11-14). A filter narrows
     * it, because the Works it names are the ones this request is about.
     */
    worksTotal: number;
    /**
     * `true` when the response holds fewer items than the set it was asked for —
     * either because a section hit spec FR-4's maximum or because the response
     * hit FR-34's cap. Spec FR-63 renders **Showing 200 of {count}** off this
     * flag.
     *
     * Judged **after** the filter: a filtered response that returned everything
     * the filter matched was not truncated, however small it is next to
     * {@link total}. The unfiltered read is the one that answers "is this
     * person's eligible set bigger than one page", which is why **Manage apps**
     * decides whether to offer the filter from the first read it makes.
     */
    truncated: boolean;
    /** The merged pinned view's size — what FR-25's budget counts (FR-62). */
    pinnedTotal: number;
}

/**
 * Fold the stored rows into one value per key, later scopes winning.
 *
 * `scopeKeys` is ordered from the widest to the most specific — for a read that
 * is `['global', <active scope>]` — and a key present in more than one scope
 * resolves to the LAST one listed. That ordering is the whole reason a pin made
 * in one Organization cannot rewrite another's row: the other Organization's
 * read simply never puts that scope in its list.
 *
 * A missing row is not a stored `false`/`true`: the defaults are spec FR-27's
 * shown and FR-24's not-pinned, and `null` order/pinOrder mean "no explicit
 * value", which is what lets {@link orderLauncherItems} fall back to the
 * catalog's order or to the newest deployment.
 */
export function mergeLauncherPreferences(
    rows: ReadonlyArray<LauncherOrderPreference>,
    scopeKeys: ReadonlyArray<string>,
): Map<string, MergedLauncherPreference> {
    const wanted = new Set(scopeKeys);
    const merged = new Map<string, MergedLauncherPreference>();

    for (const row of rows) {
        if (!row || typeof row.key !== 'string' || !wanted.has(row.scopeKey)) {
            continue;
        }
        const current: MergedLauncherPreference = merged.get(row.key) ?? {
            key: row.key,
            visible: true,
            pinned: false,
            pinOrder: null,
            order: null,
        };
        merged.set(row.key, {
            key: row.key,
            visible: typeof row.visible === 'boolean' ? row.visible : current.visible,
            pinned: typeof row.pinned === 'boolean' ? row.pinned : current.pinned,
            pinOrder: row.pinOrder === undefined ? current.pinOrder : (row.pinOrder ?? null),
            order: row.sortOrder === undefined ? current.order : (row.sortOrder ?? null),
        });
    }

    return merged;
}

/**
 * The keys the merged view holds pinned, in the order the **Pinned** row renders
 * them (FR-62): `pinOrder` where a row carries one, then pin time ascending,
 * then the key. Keys are unique, so the result is a total order and two calls
 * over the same rows return the same array.
 */
export function mergedPinnedKeys(
    rows: ReadonlyArray<LauncherOrderPreference>,
    scopeKeys: ReadonlyArray<string> = [LAUNCHER_GLOBAL_SCOPE_KEY],
): string[] {
    const merged = mergeLauncherPreferences(rows, scopeKeys);
    const pinTimes = pinTimeByKey(rows, scopeKeys);

    return [...merged.values()]
        .filter((entry) => entry.pinned)
        .sort((a, b) => {
            const aOrder = a.pinOrder ?? Number.POSITIVE_INFINITY;
            const bOrder = b.pinOrder ?? Number.POSITIVE_INFINITY;
            if (aOrder !== bOrder) {
                return aOrder - bOrder;
            }
            const aTime = pinTimes.get(a.key) ?? Number.POSITIVE_INFINITY;
            const bTime = pinTimes.get(b.key) ?? Number.POSITIVE_INFINITY;
            if (aTime !== bTime) {
                return aTime - bTime;
            }
            return compareStrings(a.key, b.key);
        })
        .map((entry) => entry.key);
}

/** How many items the merged view holds pinned — spec FR-25's count (FR-62). */
export function countMergedPins(
    rows: ReadonlyArray<LauncherOrderPreference>,
    scopeKeys: ReadonlyArray<string> = [LAUNCHER_GLOBAL_SCOPE_KEY],
): number {
    return mergedPinnedKeys(rows, scopeKeys).length;
}

/**
 * Whether the merged view is over {@link APP_LAUNCHER_PIN_LIMIT} — spec FR-25
 * evaluated exactly as FR-62 requires, over `global ∪ <active scope>` rather
 * than over one scope's rows.
 *
 * This is the read-time half of the rule; the write path re-counts inside its
 * own transaction (plan §4.2 step 3) and refuses the whole save with
 * `422 { code: 'pinLimit' }`. Both halves ask this module, so a pin cannot be
 * counted one way on the way in and another on the way out.
 */
export function isMergedPinLimitExceeded(
    rows: ReadonlyArray<LauncherOrderPreference>,
    scopeKeys: ReadonlyArray<string> = [LAUNCHER_GLOBAL_SCOPE_KEY],
): boolean {
    return appLauncherPinLimitExceeded(countMergedPins(rows, scopeKeys));
}

/**
 * Render the list (plan §4.1 steps 5-6, §4.2:420-435).
 *
 * The result is deterministic: the same inputs always produce the same array,
 * whatever order the input array happened to be in — and that holds with a
 * filter too, because filtering happens before the ordering and never inside
 * it. See the module docstring for the rule and `launcher-order.spec.ts` for
 * the proof.
 */
export function orderLauncherItems<T extends LauncherOrderableItem>(
    items: ReadonlyArray<T>,
    preferences: ReadonlyArray<LauncherOrderPreference>,
    options: OrderLauncherItemsOptions,
): OrderLauncherItemsResult<T> {
    const scopeKeys = scopeKeysFor(options.scopeKey);
    const merged = mergeLauncherPreferences(preferences, scopeKeys);
    const pinnedKeys = mergedPinnedKeys(preferences, scopeKeys);
    const pinPosition = new Map(pinnedKeys.map((key, index) => [key, index]));
    const pinTimes = pinTimeByKey(preferences, scopeKeys);

    const includeHidden = options.includeHidden === true;

    // Spec FR-4 says "the panel shows"; a Manage apps read (FR-27/FR-63) is not
    // the panel and pages at the response cap instead.
    const maxima = includeHidden
        ? {
              pinned: Number.POSITIVE_INFINITY,
              platforms: Number.POSITIVE_INFINITY,
              works: Number.POSITIVE_INFINITY,
          }
        : {
              pinned: APP_LAUNCHER_PIN_LIMIT,
              platforms: APP_LAUNCHER_PANEL_PLATFORMS_MAX,
              works: APP_LAUNCHER_PANEL_WORKS_MAX,
          };

    const eligible = items.filter((item) => {
        if (includeHidden) {
            return true;
        }
        const visible = item.visible !== false;
        const manageState = item.manageState ?? 'listed';
        return visible && manageState === 'listed';
    });

    // FR-63's `{count}` is a fact about the scope, so it is taken here — before
    // the filter narrows the set and before the cap shortens it.
    const total = eligible.length;

    // The filter narrows the ELIGIBLE set, and the cap then applies to what is
    // left. That order is the whole of FR-63's "no eligible item is
    // unreachable": filtering after the cap could only ever answer from the 200
    // items already chosen, which is exactly the reachability gap it closes.
    const matching = eligible.filter((item) => matchesLauncherFilter(item.name, options.filter));

    const worksTotal = matching.filter((item) => item.kind === 'work').length;

    const described: Array<LauncherOrderedItem<T>> = matching.map((item) => {
        const preference = merged.get(item.key);
        const pinned = preference?.pinned === true;
        const position = pinned ? pinPosition.get(item.key) : undefined;
        return {
            item,
            key: item.key,
            kind: item.kind,
            section: sectionFor(item.kind, position),
            // A stored row wins; with no row at all the item's own value is the
            // answer, which is what keeps a caller that resolved `visible` from a
            // scope this read did not ask for honest about it (spec FR-27).
            visible: preference?.visible ?? item.visible ?? true,
            pinned,
            pinOrder: position ?? null,
            order: 0,
        };
    });

    const pinned = described
        .filter((entry) => entry.section === 'pinned')
        .sort((a, b) => comparePinned(a, b, pinTimes))
        .slice(0, maxima.pinned);
    const platforms = described
        .filter((entry) => entry.section === 'platforms')
        .sort((a, b) => compareBySection(a, b, merged, 'platforms'))
        .slice(0, maxima.platforms);
    const works = described
        .filter((entry) => entry.section === 'works')
        .sort((a, b) => compareBySection(a, b, merged, 'works'))
        .slice(0, maxima.works);

    const rendered = [...pinned, ...platforms, ...works];
    const capped = rendered.slice(0, resolveLimit(options.limit));

    return {
        items: numberWithinSections(capped),
        total,
        worksTotal,
        truncated: capped.length < matching.length,
        pinnedTotal: pinnedKeys.length,
    };
}

/**
 * Reorder one section and return the write spec FR-62 requires: **every** item
 * of the section, with an explicit order from `0` to `n-1`.
 *
 * Spec FR-62 (spec.md:301-302): "A reorder writes an explicit order for every
 * item of the section it moves within." Writing only the moved row's index
 * would leave the rest on their fallback order, so the arrangement the person
 * just made would not survive a reload on another device — which is exactly the
 * failure the rule exists to prevent.
 *
 * `from` and `to` are clamped into range, so a **Move up** on the first row or
 * a **Move down** on the last is a no-op that still writes the whole section
 * (the client is not required to know it is at an edge). An empty section
 * returns an empty array.
 *
 * The caller must keep the section within `APP_LAUNCHER_MAX_CHANGES_PER_SAVE`
 * (FR-28) — this function returns one entry per key rather than truncating
 * silently, because dropping an item's order is precisely the bug the rule
 * guards against.
 */
export function reorderSection(
    sectionKeys: ReadonlyArray<string>,
    from: number,
    to: number,
): Array<{ key: string; order: number }> {
    const keys = [...sectionKeys];
    if (keys.length === 0) {
        return [];
    }

    const lastIndex = keys.length - 1;
    const source = clampIndex(from, lastIndex);
    const target = clampIndex(to, lastIndex);

    const [moved] = keys.splice(source, 1);
    keys.splice(target, 0, moved);

    return keys.map((key, order) => ({ key, order }));
}

/** `['global', <active>]`, deduped — FR-62's merged view for one request. */
function scopeKeysFor(scopeKey: string): string[] {
    return scopeKey === LAUNCHER_GLOBAL_SCOPE_KEY
        ? [LAUNCHER_GLOBAL_SCOPE_KEY]
        : [LAUNCHER_GLOBAL_SCOPE_KEY, scopeKey];
}

/**
 * Spec FR-2's sections. `pinned` wins over the item's own kind, but only for the
 * first {@link APP_LAUNCHER_PIN_LIMIT} of the merged view (spec FR-4's "at most
 * 6 pinned tiles"). A stored pin beyond that stays pinned and stays listed —
 * spec FR-62 forbids silently unpinning it — so it renders under its own kind's
 * section with its merged `pinOrder` still reported.
 */
function sectionFor(kind: AppLauncherItemKind, position: number | undefined): AppLauncherSection {
    const ownSection: AppLauncherSection = kind === 'platform' ? 'platforms' : 'works';
    if (position === undefined || position >= APP_LAUNCHER_PIN_LIMIT) {
        return ownSection;
    }
    return 'pinned';
}

/** The pin-time tie-break: the merged view's `updatedAt` for each key. */
function pinTimeByKey(
    rows: ReadonlyArray<LauncherOrderPreference>,
    scopeKeys: ReadonlyArray<string>,
): Map<string, number> {
    const wanted = new Set(scopeKeys);
    const times = new Map<string, number>();
    for (const row of rows) {
        if (!row || typeof row.key !== 'string' || !wanted.has(row.scopeKey)) {
            continue;
        }
        // Later scopes win, matching mergeLauncherPreferences.
        times.set(row.key, timeValue(row.updatedAt, Number.POSITIVE_INFINITY));
    }
    return times;
}

/**
 * FR-26 for a non-pinned section: the person's order first, then the section's
 * own fallback (the catalog's ordering number for Ever apps, the newest
 * successful deployment for Works), then the name, then the key.
 */
function compareBySection(
    a: LauncherOrderedItem<LauncherOrderableItem>,
    b: LauncherOrderedItem<LauncherOrderableItem>,
    merged: ReadonlyMap<string, MergedLauncherPreference>,
    section: 'platforms' | 'works',
): number {
    const aOrder = merged.get(a.key)?.order ?? Number.POSITIVE_INFINITY;
    const bOrder = merged.get(b.key)?.order ?? Number.POSITIVE_INFINITY;
    if (aOrder !== bOrder) {
        return aOrder - bOrder;
    }

    if (section === 'platforms') {
        const aCatalog = a.item.catalogOrder ?? Number.POSITIVE_INFINITY;
        const bCatalog = b.item.catalogOrder ?? Number.POSITIVE_INFINITY;
        if (aCatalog !== bCatalog) {
            return aCatalog - bCatalog;
        }
    } else {
        const aReady = timeValue(a.item.readyAt, Number.NEGATIVE_INFINITY);
        const bReady = timeValue(b.item.readyAt, Number.NEGATIVE_INFINITY);
        if (aReady !== bReady) {
            // "newest first" — a Work that never deployed sorts last.
            return bReady - aReady;
        }
    }

    const byName = compareOptionalStrings(a.item.name, b.item.name);
    if (byName !== 0) {
        return byName;
    }
    return compareStrings(a.key, b.key);
}

/** FR-26's pinned order: `pinOrder`, then pin time, then the key. */
function comparePinned(
    a: LauncherOrderedItem<LauncherOrderableItem>,
    b: LauncherOrderedItem<LauncherOrderableItem>,
    pinTimes: ReadonlyMap<string, number>,
): number {
    const aOrder = a.pinOrder ?? Number.POSITIVE_INFINITY;
    const bOrder = b.pinOrder ?? Number.POSITIVE_INFINITY;
    if (aOrder !== bOrder) {
        return aOrder - bOrder;
    }
    const aTime = pinTimes.get(a.key) ?? Number.POSITIVE_INFINITY;
    const bTime = pinTimes.get(b.key) ?? Number.POSITIVE_INFINITY;
    if (aTime !== bTime) {
        return aTime - bTime;
    }
    return compareStrings(a.key, b.key);
}

/**
 * `order` is the tile's position **inside its section** (plan.md:171), so each
 * section numbers from zero independently of the others.
 */
function numberWithinSections<T extends LauncherOrderableItem>(
    entries: ReadonlyArray<LauncherOrderedItem<T>>,
): Array<LauncherOrderedItem<T>> {
    const counters: Record<AppLauncherSection, number> = {
        pinned: 0,
        platforms: 0,
        works: 0,
    };
    return entries.map((entry) => ({ ...entry, order: counters[entry.section]++ }));
}

function resolveLimit(limit: number | undefined): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
        return APP_LAUNCHER_MAX_ITEMS_RESPONSE;
    }
    return Math.min(Math.floor(limit), APP_LAUNCHER_MAX_ITEMS_RESPONSE);
}

function clampIndex(index: number, lastIndex: number): number {
    if (!Number.isFinite(index)) {
        return 0;
    }
    return Math.min(Math.max(Math.trunc(index), 0), lastIndex);
}

function timeValue(value: Date | string | number | null | undefined, fallback: number): number {
    if (value instanceof Date) {
        const time = value.getTime();
        return Number.isFinite(time) ? time : fallback;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : fallback;
    }
    if (typeof value === 'string') {
        const time = Date.parse(value);
        return Number.isFinite(time) ? time : fallback;
    }
    return fallback;
}

function compareOptionalStrings(
    a: string | null | undefined,
    b: string | null | undefined,
): number {
    const left = typeof a === 'string' ? a : '';
    const right = typeof b === 'string' ? b : '';
    if (left === right) {
        return 0;
    }
    return left < right ? -1 : 1;
}

function compareStrings(a: string, b: string): number {
    if (a === b) {
        return 0;
    }
    return a < b ? -1 : 1;
}
