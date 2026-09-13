import { describe, expect, it } from 'vitest';
import {
    DEFAULT_TASKS_VIEW,
    parseTasksView,
    resolveTasksView,
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
