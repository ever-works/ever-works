import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TASK_BOARD_STATUSES } from '@ever-works/contracts';
import messages from '../../../messages/en.json';

/**
 * The Task board's message catalogue guard.
 *
 * next-intl throws at runtime on a leaf key containing a literal `.`, and a
 * missing PARENT key collapses a whole subtree — both surface as a flood of
 * red e2e shards far from the cause. This spec fails here instead:
 *
 *  - every `board.*` key the board's source asks for exists in en.json;
 *  - every board leaf is camelCase with no dot;
 *  - the status and priority labels the board reuses cover every value.
 */

const tasksPage = (messages as { dashboard: { tasksPage: Record<string, unknown> } }).dashboard
    .tasksPage;
const board = tasksPage.board as Record<string, unknown>;

const BOARD_SOURCES = ['TasksKanbanView.tsx', 'TasksList.tsx'].map((file) =>
    readFileSync(path.join(__dirname, file), 'utf8'),
);

function referencedBoardKeys(): string[] {
    const keys = new Set<string>();
    for (const source of BOARD_SOURCES) {
        for (const match of source.matchAll(/['"`]board\.([A-Za-z0-9]+)['"`]/g)) keys.add(match[1]);
        // `useTranslations('dashboard.tasksPage.board')` callers use bare leaves.
        if (source.includes("useTranslations('dashboard.tasksPage.board')")) {
            for (const match of source.matchAll(/\bt\('([A-Za-z0-9]+)'\)/g)) keys.add(match[1]);
        }
        for (const match of source.matchAll(/emptyKey: '([A-Za-z0-9]+)'/g)) keys.add(match[1]);
    }
    return [...keys].sort();
}

describe('Task board messages (en.json)', () => {
    it('has the dashboard.tasksPage.board parent', () => {
        expect(board).toBeTypeOf('object');
    });

    it('resolves every board key the components ask for', () => {
        const referenced = referencedBoardKeys();
        // Guard the guard: the scan really found the board's keys.
        expect(referenced).toEqual(expect.arrayContaining(['moveTo', 'showMore', 'emptyTodo']));
        const missing = referenced.filter((key) => typeof board[key] !== 'string');
        expect(missing).toEqual([]);
    });

    it('names every board leaf in camelCase with no literal dot', () => {
        for (const [key, value] of Object.entries(board)) {
            expect(key).toMatch(/^[a-z][A-Za-z0-9]*$/);
            expect(typeof value).toBe('string');
            expect((value as string).length).toBeGreaterThan(0);
        }
    });

    it('reuses a status label for every Task status the board renders', () => {
        const status = tasksPage.status as Record<string, string>;
        for (const value of TASK_BOARD_STATUSES) {
            expect(typeof status[value]).toBe('string');
        }
    });

    it('reuses a priority label for all five priorities', () => {
        const priority = tasksPage.priority as Record<string, string>;
        expect(Object.keys(priority).sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    });

    it('keeps the view switcher’s board label on the existing translated key', () => {
        const list = tasksPage.list as Record<string, unknown>;
        expect(list.kanban).toBe('Kanban');
        expect((list.filter as Record<string, unknown>).all).toBe('All');
    });
});
