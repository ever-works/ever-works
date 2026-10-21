import { describe, expect, it } from 'vitest';
import type { FleetHandoffComputer, FleetHandoffNodeCheckouts } from '@ever-works/contracts';
import {
    checkoutCreateRequest,
    choiceStillOffered,
    handoffStartRequest,
    initialCheckoutChoice,
    initialComputerId,
    nothingSelectable,
} from './task-handoff.shared';
import { taskComputerAgo } from './task-fleet-block.shared';

const computer = (patch: Partial<FleetHandoffComputer>): FleetHandoffComputer => ({
    nodeId: 'n-1',
    name: 'build-01',
    online: true,
    lastSeenAt: null,
    os: 'linux/x64',
    clis: ['claude-code'],
    selectable: true,
    reason: null,
    hint: null,
    pinned: false,
    liveAgentSessions: 0,
    slots: 2,
    ...patch,
});

const step = (patch: Partial<FleetHandoffNodeCheckouts> = {}): FleetHandoffNodeCheckouts => ({
    nodeId: 'n-1',
    matching: [
        {
            checkoutId: 'c-1',
            path: '/code/api',
            kind: 'clone',
            branch: 'main',
            repository: 'acme/api',
            matchesTask: true,
        },
    ],
    others: [],
    defaultMode: 'worktree',
    stale: null,
    ...patch,
});

const task = { repoUrl: 'https://github.com/acme/api.git', branch: 'task/login-1' };

describe('initialComputerId (FL-15 FR-3)', () => {
    it('starts on the pinned computer, else the first selectable one', () => {
        expect(
            initialComputerId([
                computer({ nodeId: 'a', selectable: true }),
                computer({ nodeId: 'b', pinned: true, selectable: true }),
            ]),
        ).toBe('b');
        expect(initialComputerId([computer({ nodeId: 'a', selectable: false }), computer({ nodeId: 'c' })])).toBe('c');
        expect(initialComputerId([computer({ selectable: false })])).toBeNull();
    });

    it('knows when nothing is selectable (U1)', () => {
        expect(nothingSelectable([computer({ selectable: false })])).toBe(true);
        expect(nothingSelectable([computer({})])).toBe(false);
    });
});

describe('the checkout choice (FR-5, U7)', () => {
    it('defaults to a new worktree of the matching checkout', () => {
        expect(initialCheckoutChoice(step(), task)).toEqual({ mode: 'worktree', parentCheckoutId: 'c-1' });
    });

    it('reuses a checkout already on the Task branch', () => {
        const withTaskBranch = step({
            matching: [
                { checkoutId: 'c-1', path: '/code/api', kind: 'clone', branch: 'main', repository: 'acme/api', matchesTask: true },
                {
                    checkoutId: 'c-2',
                    path: '/code/api-task',
                    kind: 'worktree',
                    branch: 'task/login-1',
                    repository: 'acme/api',
                    matchesTask: true,
                },
            ],
        });
        expect(initialCheckoutChoice(withTaskBranch, task)).toEqual({ mode: 'existing', checkoutId: 'c-2' });
    });

    it('falls back to a fresh clone, then the home folder', () => {
        expect(initialCheckoutChoice(step({ matching: [], defaultMode: 'clone' }), task)).toEqual({ mode: 'clone' });
        expect(initialCheckoutChoice(undefined, { repoUrl: null })).toEqual({ mode: 'none' });
    });

    it('drops a choice the new computer does not offer', () => {
        expect(choiceStillOffered({ mode: 'worktree', parentCheckoutId: 'c-1' }, step(), task)).toBe(true);
        expect(choiceStillOffered({ mode: 'worktree', parentCheckoutId: 'c-9' }, step(), task)).toBe(false);
        expect(choiceStillOffered({ mode: 'clone' }, step(), { repoUrl: null })).toBe(false);
    });

    it('asks FL-14 for a worktree or a clone on the Task branch, and nothing otherwise', () => {
        expect(checkoutCreateRequest('n-1', { mode: 'worktree', parentCheckoutId: 'c-1' }, task)).toEqual({
            nodeId: 'n-1',
            source: { kind: 'worktree', parentCheckoutId: 'c-1' },
            branch: 'task/login-1',
        });
        expect(checkoutCreateRequest('n-1', { mode: 'clone' }, task)).toEqual({
            nodeId: 'n-1',
            source: { kind: 'clone', repoUrl: 'https://github.com/acme/api.git' },
            branch: 'task/login-1',
        });
        expect(checkoutCreateRequest('n-1', { mode: 'existing', checkoutId: 'c-1' }, task)).toBeNull();
        expect(checkoutCreateRequest('n-1', { mode: 'none' }, task)).toBeNull();
    });
});

describe('handoffStartRequest (FR-6)', () => {
    it('starts an Agent session with the Task named, in the checkout or the home folder', () => {
        expect(
            handoffStartRequest({
                taskId: 't-1',
                agent: { id: 'a-1', cli: 'codex' },
                firstMessage: 'Fix T-1',
                checkout: { id: 'c-2', path: '/code/api-task' },
            }),
        ).toEqual({
            kind: 'agent',
            provider: 'codex',
            agentId: 'a-1',
            taskId: 't-1',
            firstMessage: 'Fix T-1',
            cwd: '/code/api-task',
            checkoutId: 'c-2',
        });
        expect(
            handoffStartRequest({ taskId: 't-1', agent: { id: 'a-1', cli: 'claude-code' }, firstMessage: 'x', checkout: null })
                .cwd,
        ).toBe('~');
    });
});

describe('taskComputerAgo', () => {
    it('reads minutes, hours and days', () => {
        const now = Date.parse('2026-10-21T12:00:00Z');
        expect(taskComputerAgo('2026-10-21T11:56:00Z', now)).toBe('4 min');
        expect(taskComputerAgo('2026-10-21T10:00:00Z', now)).toBe('2 h');
        expect(taskComputerAgo('2026-10-18T12:00:00Z', now)).toBe('3 d');
        expect(taskComputerAgo('nope', now)).toBeNull();
    });
});
