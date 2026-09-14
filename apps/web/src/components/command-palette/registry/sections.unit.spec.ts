import { describe, expect, it, vi } from 'vitest';
import type {
    WorkspaceSearchGroup,
    WorkspaceSearchHit,
    WorkspaceSearchKind,
    WorkspaceSearchResponse,
} from '@ever-works/contracts/api';
import { createEnTranslator } from '../__tests__/en-translator';
import type { PaletteRecentEntry } from '../hooks/use-palette-recents';
import { commandsFor } from './commands';
import { localMatchScore } from './local-match';
import { screensFor } from './screens';
import {
    buildPaletteSections,
    flattenRows,
    PALETTE_TOTAL_ROWS,
    type BuildPaletteSectionsInput,
} from './sections';
import type { PaletteCommandContext } from './types';

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn() }),
    usePathname: () => '/',
}));

const t = createEnTranslator();

function ctx(): PaletteCommandContext {
    return {
        t,
        pathname: '/dashboard',
        navigate: vi.fn(),
        openHelp: vi.fn(),
        toggleTheme: vi.fn(),
        isDark: false,
        sidebarCollapsed: false,
        setSidebarCollapsed: vi.fn(),
        chatOpen: false,
        setChatOpen: vi.fn(),
        copyLink: vi.fn(),
        signOut: vi.fn(),
        switchOrganization: vi.fn(),
        organizations: [],
        activeOrganizationSlug: null,
    };
}

function hit(
    kind: WorkspaceSearchKind,
    sourceId: string,
    title: string,
    score = 65,
): WorkspaceSearchHit {
    return {
        id: `${kind}:${sourceId}`,
        kind,
        sourceId,
        title,
        subtitle: null,
        statusLabel: kind === 'task' ? 'in_review' : 'active',
        destination: `/${kind}s/${sourceId}`,
        score,
        matchReason: 'contains',
        updatedAt: null,
    };
}

function group(
    kind: WorkspaceSearchKind,
    hits: WorkspaceSearchHit[],
    total = hits.length,
): WorkspaceSearchGroup {
    return { kind, total, hits };
}

function response(
    groups: WorkspaceSearchGroup[],
    degradedKinds: WorkspaceSearchKind[] = [],
): WorkspaceSearchResponse {
    return { query: 'invoice', groups, degradedKinds, servedBy: 'fanout', tookMs: 12 };
}

function recent(
    kind: WorkspaceSearchKind,
    sourceId: string,
    title: string,
    openedAt: number,
): PaletteRecentEntry {
    return {
        key: `${kind}:${sourceId}`,
        kind,
        sourceId,
        title,
        subtitle: null,
        statusLabel: null,
        destination: `/${kind}s/${sourceId}`,
        openedAt,
    };
}

function input(overrides: Partial<BuildPaletteSectionsInput> = {}): BuildPaletteSectionsInput {
    const commandContext = ctx();
    return {
        t,
        query: '',
        filter: null,
        commandContext,
        commands: commandsFor(commandContext),
        screens: screensFor('/dashboard'),
        recents: [],
        response: null,
        settled: false,
        ...overrides,
    };
}

describe('buildPaletteSections', () => {
    it('shows Recent then Suggested on an empty query', () => {
        const recents = Array.from({ length: 8 }, (_, index) =>
            recent('mission', `m${index}`, `Mission ${index}`, 1000 - index),
        );
        const sections = buildPaletteSections(input({ recents }));
        expect(sections.map((section) => section.kind)).toEqual(['recent', 'suggested']);
        expect(sections[0].rows).toHaveLength(5);
        expect(sections[0].rows[0].title).toBe('Mission 0');
        expect(sections[1].rows.length).toBeLessThanOrEqual(6);
        expect(sections[1].rows.every((row) => row.action.type === 'command')).toBe(true);
    });

    it('filters Recent and Commands locally for one character and never builds record groups', () => {
        const sections = buildPaletteSections(
            input({
                query: 'n',
                recents: [recent('task', 't1', 'Nightly report', 1)],
                response: response([group('mission', [hit('mission', 'm1', 'Night shift')])]),
            }),
        );
        expect(sections.map((section) => section.kind)).toEqual(['recent', 'command']);
    });

    it('puts Commands above record groups for "new mission", with New Mission first', () => {
        const sections = buildPaletteSections(
            input({
                query: 'new mission',
                response: response([
                    group('mission', [hit('mission', 'm1', 'A new mission plan')]),
                ]),
                settled: true,
            }),
        );
        expect(sections[0].kind).toBe('command');
        expect(sections[0].rows[0].key).toBe('command:newMission');
    });

    it('surfaces Open Help and Keyboard shortcuts for "help"', () => {
        const sections = buildPaletteSections(input({ query: 'help', settled: true }));
        const commandKeys = sections
            .find((section) => section.kind === 'command')
            ?.rows.map((row) => row.key);
        expect(commandKeys).toEqual(
            expect.arrayContaining(['command:openHelp', 'command:keyboardShortcuts']),
        );
    });

    it('reaches deep Settings screens with their breadcrumb', () => {
        const sections = buildPaletteSections(input({ query: 'runtime', settled: true }));
        const screen = sections.find((section) => section.kind === 'screen')?.rows[0];
        expect(screen?.title).toBe('Job Runtime');
        expect(screen?.subtitle).toBe('Settings');
    });

    it('renders Missions and Tasks as two separate groups', () => {
        const sections = buildPaletteSections(
            input({
                query: 'invoice',
                response: response([
                    group('mission', [hit('mission', 'm1', 'Invoice reconciliation')]),
                    group('task', [hit('task', 't1', 'Invoice follow-up')]),
                ]),
                settled: true,
            }),
        );
        const missions = sections.find((section) => section.kind === 'mission');
        const tasks = sections.find((section) => section.kind === 'task');
        expect(missions?.heading).toBe('Missions');
        expect(tasks?.heading).toBe('Tasks');
        expect(missions?.rows.map((row) => row.key)).toEqual(['record:mission:m1']);
        expect(tasks?.rows.map((row) => row.key)).toEqual(['record:task:t1']);
        expect(tasks?.rows[0].badge).toBe('In review');
    });

    it('promotes a group holding an exact match above the rest', () => {
        const sections = buildPaletteSections(
            input({
                query: 'ivy',
                response: response([
                    group('mission', [hit('mission', 'm1', 'Ivy onboarding')]),
                    group('agent', [hit('agent', 'a1', 'Ivy', 100)]),
                ]),
                settled: true,
            }),
        );
        expect(sections[0].kind).toBe('agent');
    });

    it('caps a group at five rows plus "Show all", and at 25 under a filter with the escape hatch', () => {
        const hits = Array.from({ length: 25 }, (_, index) =>
            hit('task', `t${index}`, `Invoice ${index}`),
        );
        const unfiltered = buildPaletteSections(
            input({
                query: 'invoice',
                response: response([group('task', hits.slice(0, 5), 137)]),
                settled: true,
            }),
        );
        const tasks = unfiltered.find((section) => section.kind === 'task');
        expect(tasks?.rows).toHaveLength(6);
        expect(tasks?.rows[5].action).toEqual({ type: 'showAll', filter: 'task' });
        expect(tasks?.rows[5].title).toBe('Show all 137');

        const filtered = buildPaletteSections(
            input({
                query: 'invoice',
                filter: 'task',
                response: response([group('task', hits, 137)]),
                settled: true,
            }),
        );
        expect(filtered).toHaveLength(1);
        expect(filtered[0].heading).toBe('Tasks · showing 25 of 137');
        expect(filtered[0].rows).toHaveLength(26);
        expect(filtered[0].rows[25].action).toEqual({ type: 'openList', href: '/tasks' });
    });

    it('never exceeds 60 rows in total', () => {
        const kinds: WorkspaceSearchKind[] = [
            'mission',
            'task',
            'agent',
            'work',
            'idea',
            'skill',
            'team',
            'knowledge',
        ];
        const groups = kinds.map((kind) =>
            group(
                kind,
                Array.from({ length: 5 }, (_, index) =>
                    hit(kind, `${kind}${index}`, `Alpha ${index}`),
                ),
                40,
            ),
        );
        const sections = buildPaletteSections(
            input({ query: 'alpha', response: response(groups), settled: true }),
        );
        expect(flattenRows(sections).length).toBeLessThanOrEqual(PALETTE_TOTAL_ROWS);
    });

    it('offers exactly the three fallback rows when a settled query matches nothing', () => {
        const sections = buildPaletteSections(
            input({ query: 'zzzqqq', response: response([]), settled: true }),
        );
        expect(sections).toHaveLength(1);
        expect(sections[0].kind).toBe('fallback');
        expect(sections[0].rows.map((row) => row.action.type)).toEqual([
            'askChat',
            'createTask',
            'openHelp',
        ]);
        expect(sections[0].rows[0].title).toBe('Ask the AI chat panel about “zzzqqq”');
    });

    it('shows no fallback while the query is still loading', () => {
        expect(buildPaletteSections(input({ query: 'zzzqqq', settled: false }))).toEqual([]);
    });

    it('narrows to local groups without server rows', () => {
        const sections = buildPaletteSections(
            input({
                query: 'new',
                filter: 'command',
                response: response([group('mission', [hit('mission', 'm1', 'New pricing')])]),
                settled: true,
            }),
        );
        expect(sections.map((section) => section.kind)).toEqual(['command']);
        expect(sections[0].heading).toMatch(/^Commands · showing \d+ of \d+$/);
    });
});

describe('localMatchScore', () => {
    it('ranks exact above prefix above word prefix above contains above alias above fuzzy', () => {
        expect(localMatchScore('new task', 'New Task')).toBe(100);
        expect(localMatchScore('new', 'New Task')).toBe(90);
        expect(localMatchScore('task', 'New Task')).toBe(80);
        expect(localMatchScore('ew ta', 'New Task')).toBe(65);
        expect(localMatchScore('create task', 'New Task', 'create task, add task')).toBe(60);
        expect(localMatchScore('nwtsk', 'New Task')).toBe(25);
        expect(localMatchScore('zzz', 'New Task')).toBeNull();
    });

    it('ignores case and Latin diacritics', () => {
        expect(localMatchScore('CAFE', 'Café menu')).toBe(90);
    });
});
