import {
    ArrowRight,
    FileText,
    HelpCircle,
    ListChecks,
    MessageSquare,
    MoreHorizontal,
    type LucideIcon,
} from 'lucide-react';
import type {
    WorkspaceSearchHit,
    WorkspaceSearchKind,
    WorkspaceSearchResponse,
} from '@ever-works/contracts/api';
import type { PaletteRecentEntry } from '../hooks/use-palette-recents';
import { localMatchScore } from './local-match';
import { isRecordKind, PALETTE_KINDS, statusBadge } from './kinds';
import type {
    PaletteCommand,
    PaletteCommandContext,
    PaletteScreen,
    PaletteTranslator,
} from './types';

/** Rows a group shows before its "Show all" row. */
export const PALETTE_GROUP_ROWS = 5;
/** Rows one group shows while it is the active filter. */
export const PALETTE_FILTERED_ROWS = 25;
/** Rows the whole palette shows at most. */
export const PALETTE_TOTAL_ROWS = 60;
/** Recent rows on the empty palette. */
export const PALETTE_RECENT_ROWS = 5;
/** Suggested commands on the empty palette. */
export const PALETTE_SUGGESTED_ROWS = 6;
/** Shortest query that reaches the server. */
export const PALETTE_MIN_QUERY_LENGTH = 2;

const MAX_SCORE = 100;

/** A group the operator can narrow the palette to. */
export type PaletteFilter = 'command' | 'screen' | WorkspaceSearchKind;

export type PaletteSectionKind = 'recent' | 'suggested' | 'fallback' | PaletteFilter;

/** The fields a record row needs to open and to be remembered as Recent. */
export type PaletteRecordTarget = Pick<
    WorkspaceSearchHit,
    'kind' | 'sourceId' | 'title' | 'subtitle' | 'statusLabel' | 'destination'
>;

export type PaletteRowAction =
    | { type: 'command'; command: PaletteCommand }
    | { type: 'screen'; href: string }
    | { type: 'record'; record: PaletteRecordTarget }
    | { type: 'showAll'; filter: PaletteFilter }
    | { type: 'openList'; href: string }
    | { type: 'askChat' }
    | { type: 'createTask' }
    | { type: 'openHelp' };

export interface PaletteRow {
    /** Unique across the whole palette; also the cmdk item value. */
    key: string;
    icon: LucideIcon;
    title: string;
    subtitle: string | null;
    badge: string | null;
    action: PaletteRowAction;
    /** The group `Tab` narrows to from this row, or null when it cannot narrow. */
    filter: PaletteFilter | null;
}

export interface PaletteSection {
    key: string;
    kind: PaletteSectionKind;
    heading: string;
    /** Matches before the cap, shown beside the heading; null for fixed lists. */
    total: number | null;
    rows: PaletteRow[];
}

export interface BuildPaletteSectionsInput {
    t: PaletteTranslator;
    query: string;
    filter: PaletteFilter | null;
    commandContext: PaletteCommandContext;
    /** Commands that apply right now, in registry order. */
    commands: readonly PaletteCommand[];
    screens: readonly PaletteScreen[];
    recents: readonly PaletteRecentEntry[];
    /** Last good server answer, or null. */
    response: WorkspaceSearchResponse | null;
    /** True once the query on screen has a settled server answer. */
    settled: boolean;
}

interface Candidate {
    section: PaletteSection;
    hasExact: boolean;
}

function recordRow(t: PaletteTranslator, prefix: string, target: PaletteRecordTarget): PaletteRow {
    const descriptor = PALETTE_KINDS[target.kind];
    return {
        key: `${prefix}:${target.kind}:${target.sourceId}`,
        icon: descriptor?.icon ?? FileText,
        title: target.title,
        subtitle: target.subtitle,
        badge: statusBadge(t, target.kind, target.statusLabel),
        action: { type: 'record', record: target },
        filter: target.kind,
    };
}

function recentRow(t: PaletteTranslator, entry: PaletteRecentEntry): PaletteRow {
    const row = recordRow(t, 'recent', entry);
    const kindLabel = PALETTE_KINDS[entry.kind]?.groupLabel(t) ?? null;
    const parts = [kindLabel, entry.subtitle].filter((part): part is string => Boolean(part));
    return { ...row, subtitle: parts.length > 0 ? parts.join(' · ') : null };
}

function commandRow(ctx: PaletteCommandContext, command: PaletteCommand): PaletteRow {
    return {
        key: `command:${command.id}`,
        icon: command.icon,
        title: command.label(ctx),
        subtitle: null,
        badge: null,
        action: { type: 'command', command },
        filter: 'command',
    };
}

function screenRow(t: PaletteTranslator, screen: PaletteScreen): PaletteRow {
    const breadcrumb = screen.breadcrumb?.(t) ?? [];
    return {
        key: `screen:${screen.id}`,
        icon: screen.icon,
        title: screen.title(t),
        subtitle: breadcrumb.length > 0 ? breadcrumb.join(' / ') : null,
        badge: null,
        action: { type: 'screen', href: screen.href },
        filter: 'screen',
    };
}

/** Score-ordered matches, registry order breaking ties. */
function rank<T>(
    items: readonly T[],
    score: (item: T) => number | null,
): Array<{ item: T; score: number }> {
    return items
        .map((item, index) => ({ item, index, score: score(item) }))
        .filter((entry): entry is { item: T; index: number; score: number } => entry.score !== null)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map(({ item, score: value }) => ({ item, score: value }));
}

function groupHeading(
    t: PaletteTranslator,
    label: string,
    filtered: boolean,
    shown: number,
    total: number,
): string {
    return filtered
        ? t('dashboard.commandPalette.filteredHeader', { group: label, shown, total })
        : label;
}

function showAllRow(t: PaletteTranslator, filter: PaletteFilter, total: number): PaletteRow {
    return {
        key: `showAll:${filter}`,
        icon: MoreHorizontal,
        title: t('dashboard.commandPalette.showAll', { count: total }),
        subtitle: null,
        badge: null,
        action: { type: 'showAll', filter },
        filter,
    };
}

function localSection(
    t: PaletteTranslator,
    kind: 'command' | 'screen',
    label: string,
    rows: PaletteRow[],
    exact: boolean,
    filtered: boolean,
): Candidate | null {
    if (rows.length === 0) return null;
    const cap = filtered ? PALETTE_FILTERED_ROWS : PALETTE_GROUP_ROWS;
    const shown = rows.slice(0, cap);
    if (!filtered && rows.length > shown.length) shown.push(showAllRow(t, kind, rows.length));
    return {
        section: {
            key: kind,
            kind,
            heading: groupHeading(t, label, filtered, Math.min(rows.length, cap), rows.length),
            total: rows.length,
            rows: shown,
        },
        hasExact: exact,
    };
}

function commandCandidate(
    input: BuildPaletteSectionsInput,
    query: string,
    filtered: boolean,
): Candidate | null {
    const ctx = input.commandContext;
    const ranked = rank(input.commands, (command) =>
        localMatchScore(query, command.label(ctx), command.aliases(ctx)),
    );
    return localSection(
        input.t,
        'command',
        input.t('dashboard.commandPalette.groups.commands'),
        ranked.map(({ item }) => commandRow(ctx, item)),
        ranked.some(({ score }) => score >= MAX_SCORE),
        filtered,
    );
}

function screenCandidate(
    input: BuildPaletteSectionsInput,
    query: string,
    filtered: boolean,
): Candidate | null {
    const { t } = input;
    const ranked = rank(input.screens, (screen) =>
        localMatchScore(query, screen.title(t), '', screen.breadcrumb?.(t) ?? []),
    );
    return localSection(
        t,
        'screen',
        t('dashboard.commandPalette.groups.screens'),
        ranked.map(({ item }) => screenRow(t, item)),
        ranked.some(({ score }) => score >= MAX_SCORE),
        filtered,
    );
}

function recordCandidates(
    input: BuildPaletteSectionsInput,
    filter: WorkspaceSearchKind | null,
): Candidate[] {
    const { t, response } = input;
    if (!response) return [];
    const cap = filter ? PALETTE_FILTERED_ROWS : PALETTE_GROUP_ROWS;
    const out: Candidate[] = [];
    for (const group of response.groups) {
        if (!isRecordKind(group.kind)) continue;
        if (filter && group.kind !== filter) continue;
        const hits = group.hits.slice(0, cap);
        if (hits.length === 0) continue;
        const descriptor = PALETTE_KINDS[group.kind];
        const label = descriptor.groupLabel(t);
        const total = Math.max(group.total, hits.length);
        const rows = hits.map((hit) => recordRow(t, 'record', hit));
        if (!filter && total > hits.length) {
            rows.push(showAllRow(t, group.kind, total));
        } else if (filter && total > hits.length && descriptor.listHref) {
            rows.push({
                key: `openList:${group.kind}`,
                icon: ArrowRight,
                title: t('dashboard.commandPalette.openFullList', { group: label }),
                subtitle: null,
                badge: null,
                action: { type: 'openList', href: descriptor.listHref },
                filter: null,
            });
        }
        out.push({
            section: {
                key: group.kind,
                kind: group.kind,
                heading: groupHeading(t, label, Boolean(filter), hits.length, total),
                total,
                rows,
            },
            hasExact: hits.some((hit) => hit.score >= MAX_SCORE),
        });
    }
    return out;
}

function fallbackSection(t: PaletteTranslator, query: string): PaletteSection {
    return {
        key: 'fallback',
        kind: 'fallback',
        heading: t('dashboard.commandPalette.noResults.hint'),
        total: null,
        rows: [
            {
                key: 'fallback:askChat',
                icon: MessageSquare,
                title: t('dashboard.commandPalette.noResults.askChat', { query }),
                subtitle: null,
                badge: null,
                action: { type: 'askChat' },
                filter: null,
            },
            {
                key: 'fallback:createTask',
                icon: ListChecks,
                title: t('dashboard.commandPalette.noResults.createTask', { query }),
                subtitle: null,
                badge: null,
                action: { type: 'createTask' },
                filter: null,
            },
            {
                key: 'fallback:openHelp',
                icon: HelpCircle,
                title: t('dashboard.commandPalette.noResults.openHelp'),
                subtitle: null,
                badge: null,
                action: { type: 'openHelp' },
                filter: null,
            },
        ],
    };
}

/** Cut the sections so the whole palette never exceeds {@link PALETTE_TOTAL_ROWS}. */
function capTotal(sections: PaletteSection[]): PaletteSection[] {
    let remaining = PALETTE_TOTAL_ROWS;
    const out: PaletteSection[] = [];
    for (const section of sections) {
        if (remaining <= 0) break;
        const rows = section.rows.slice(0, remaining);
        remaining -= rows.length;
        out.push({ ...section, rows });
    }
    return out;
}

/** Local-only sections for an empty or one-character query. */
function localOnlySections(input: BuildPaletteSectionsInput, query: string): PaletteSection[] {
    const { t, filter } = input;
    if (filter === 'command') {
        return compact([commandCandidate(input, query, true)?.section]);
    }
    if (filter === 'screen') {
        return compact([screenCandidate(input, query, true)?.section]);
    }

    const recents = input.recents
        .filter((entry) => !filter || entry.kind === filter)
        .map((entry) => ({
            entry,
            score: localMatchScore(query, entry.title, '', [entry.subtitle ?? '']),
        }))
        .filter(({ score }) => score !== null)
        .slice(0, filter ? PALETTE_FILTERED_ROWS : PALETTE_RECENT_ROWS)
        .map(({ entry }) => recentRow(t, entry));
    const recentSection: PaletteSection | undefined =
        recents.length > 0
            ? {
                  key: 'recent',
                  kind: 'recent',
                  heading: t('dashboard.commandPalette.groups.recent'),
                  total: null,
                  rows: recents,
              }
            : undefined;
    if (filter) return compact([recentSection]);

    if (query.length === 0) {
        const ctx = input.commandContext;
        const suggested = input.commands
            .filter((command) => command.suggested)
            .slice(0, PALETTE_SUGGESTED_ROWS)
            .map((command) => ({ ...commandRow(ctx, command), key: `suggested:${command.id}` }));
        return compact([
            recentSection,
            suggested.length > 0
                ? {
                      key: 'suggested',
                      kind: 'suggested',
                      heading: t('dashboard.commandPalette.groups.suggested'),
                      total: null,
                      rows: suggested,
                  }
                : undefined,
        ]);
    }

    return compact([recentSection, commandCandidate(input, query, false)?.section]);
}

function compact(sections: Array<PaletteSection | undefined>): PaletteSection[] {
    return sections.filter((section): section is PaletteSection =>
        Boolean(section && section.rows.length > 0),
    );
}

/**
 * Everything the palette shows for one state, as ordered sections of rows.
 * Pure: the component renders exactly this, and the unit spec asserts it.
 *
 * - empty query → Recent (5) + Suggested (6);
 * - one character → Recent + Commands, filtered locally, no request;
 * - two or more → Commands, Screens and every record group the server
 *   returned, a group holding an exact match first, 5 rows per group with a
 *   "Show all" row, 25 under a filter, 60 in total;
 * - a settled query with no row anywhere → the three fallback rows.
 */
export function buildPaletteSections(input: BuildPaletteSectionsInput): PaletteSection[] {
    const query = input.query.trim();
    const { filter } = input;
    if (query.length < PALETTE_MIN_QUERY_LENGTH) {
        return capTotal(localOnlySections(input, query));
    }

    const candidates: Candidate[] = [];
    if (!filter || filter === 'command') {
        const commands = commandCandidate(input, query, filter === 'command');
        if (commands) candidates.push(commands);
    }
    if (!filter || filter === 'screen') {
        const screens = screenCandidate(input, query, filter === 'screen');
        if (screens) candidates.push(screens);
    }
    if (!filter || isRecordKind(filter)) {
        candidates.push(...recordCandidates(input, filter && isRecordKind(filter) ? filter : null));
    }

    // Stable: a group holding an exact match moves to the top, otherwise the
    // order is Commands, Screens, then the server's own group order.
    const ordered = candidates
        .map((candidate, index) => ({ candidate, index }))
        .sort(
            (a, b) =>
                Number(b.candidate.hasExact) - Number(a.candidate.hasExact) || a.index - b.index,
        )
        .map(({ candidate }) => candidate.section);

    if (ordered.length === 0) {
        return input.settled ? [fallbackSection(input.t, query)] : [];
    }
    return capTotal(ordered);
}

/** Every row in render order — what arrow keys and `Ctrl/Cmd+1..9` walk. */
export function flattenRows(sections: readonly PaletteSection[]): PaletteRow[] {
    return sections.flatMap((section) => section.rows);
}

/** The filter a section narrows to, for the chip label. */
export function filterLabel(t: PaletteTranslator, filter: PaletteFilter): string {
    if (filter === 'command') return t('dashboard.commandPalette.groups.commands');
    if (filter === 'screen') return t('dashboard.commandPalette.groups.screens');
    return PALETTE_KINDS[filter].groupLabel(t);
}
