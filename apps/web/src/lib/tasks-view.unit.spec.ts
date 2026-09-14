import { describe, expect, it } from 'vitest';
import {
    DEFAULT_SCOPED_BOARD_SORT,
    DEFAULT_TASKS_BOARD_DONE_WINDOW,
    DEFAULT_TASKS_BOARD_SORT,
    DEFAULT_TASKS_VIEW,
    parseTasksBoardDoneWindow,
    parseTasksBoardSort,
    parseTasksView,
    resolveTasksBoardDoneWindow,
    resolveTasksBoardSort,
    resolveTasksView,
    TASKS_BOARD_DONE_PARAM,
    TASKS_BOARD_DONE_WINDOWS,
    TASKS_BOARD_SORT_PARAM,
    TASKS_VIEW_COOKIE,
    tasksViewCookie,
} from './tasks-view';

describe('resolveTasksView', () => {
    it('lets the URL beat the cookie', () => {
        expect(resolveTasksView({ url: 'table', cookie: 'board' })).toBe('table');
    });

    it('falls back to the cookie when the URL carries no view', () => {
        expect(resolveTasksView({ url: undefined, cookie: 'board' })).toBe('board');
        expect(resolveTasksView({ url: null, cookie: 'table' })).toBe('table');
    });

    it('falls back to the default when neither source says anything', () => {
        expect(resolveTasksView({})).toBe(DEFAULT_TASKS_VIEW);
        expect(DEFAULT_TASKS_VIEW).toBe('cards');
    });

    it('skips an invalid URL value rather than ignoring a valid cookie', () => {
        expect(resolveTasksView({ url: 'grid', cookie: 'board' })).toBe('board');
        expect(resolveTasksView({ url: 'grid', cookie: 'nonsense' })).toBe('cards');
    });

    it('reads the first value of a repeated query parameter', () => {
        expect(resolveTasksView({ url: ['board', 'table'] })).toBe('board');
    });
});

describe('parseTasksView', () => {
    it.each([
        ['cards', 'cards'],
        ['table', 'table'],
        ['board', 'board'],
        ['kanban', 'board'],
        [' Board ', 'board'],
        ['', null],
        ['list', null],
        [undefined, null],
        [42, null],
    ])('%p → %p', (input, expected) => {
        expect(parseTasksView(input)).toBe(expected);
    });
});

describe('board sort (?sort=)', () => {
    it('opens the /tasks board on priority and scoped lists on recently updated', () => {
        expect(TASKS_BOARD_SORT_PARAM).toBe('sort');
        expect(DEFAULT_TASKS_BOARD_SORT).toBe('priority');
        expect(DEFAULT_SCOPED_BOARD_SORT).toBe('updated');
    });

    it.each([
        ['priority', 'priority'],
        ['updated', 'updated'],
        [' Updated ', 'updated'],
        ['recent', null],
        ['', null],
        [undefined, null],
        [7, null],
    ])('parses %s as %s', (input, expected) => {
        expect(parseTasksBoardSort(input)).toBe(expected);
    });

    it('lets the URL beat the default, and skips an invalid URL value', () => {
        expect(resolveTasksBoardSort('updated')).toBe('updated');
        expect(resolveTasksBoardSort(undefined)).toBe('priority');
        expect(resolveTasksBoardSort('bogus')).toBe('priority');
        expect(resolveTasksBoardSort(null, 'updated')).toBe('updated');
        expect(resolveTasksBoardSort(['updated', 'priority'])).toBe('updated');
    });
});

describe('board completed-Task window (?done=)', () => {
    it('offers 7, 30 and 90 days and all time, defaulting to 7 days', () => {
        expect(TASKS_BOARD_DONE_PARAM).toBe('done');
        expect(TASKS_BOARD_DONE_WINDOWS).toEqual([7, 30, 90, 'all']);
        expect(DEFAULT_TASKS_BOARD_DONE_WINDOW).toBe(7);
    });

    it.each([
        ['7', 7],
        ['30', 30],
        ['90', 90],
        ['all', 'all'],
        [' ALL ', 'all'],
        [30, 30],
        ['all' as const, 'all'],
        ['14', null],
        ['365', null],
        ['', null],
        [undefined, null],
    ])('parses %s as %s', (input, expected) => {
        expect(parseTasksBoardDoneWindow(input)).toBe(expected);
    });

    it('lets the URL beat the default, and skips an invalid URL value', () => {
        expect(resolveTasksBoardDoneWindow('all')).toBe('all');
        expect(resolveTasksBoardDoneWindow(null)).toBe(7);
        expect(resolveTasksBoardDoneWindow('forever')).toBe(7);
        expect(resolveTasksBoardDoneWindow(['90', '7'])).toBe(90);
    });
});

describe('tasksViewCookie', () => {
    it('remembers the view site-wide for a year', () => {
        expect(tasksViewCookie('board', { secure: false })).toBe(
            `${TASKS_VIEW_COOKIE}=board; path=/; max-age=31536000; SameSite=Lax`,
        );
    });

    it('marks the cookie Secure on https', () => {
        expect(tasksViewCookie('table', { secure: true })).toMatch(/; Secure$/);
    });
});
