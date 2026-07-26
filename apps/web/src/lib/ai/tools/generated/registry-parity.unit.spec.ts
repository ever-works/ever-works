import { describe, expect, it } from 'vitest';
import { ALL_OPERATIONS } from './registry.all';
import { selectActiveToolNames } from '../tool-selection';

/**
 * Platform ↔ web tool-surface parity for the three tools that had no REST
 * operation to bind to.
 *
 * `list_recent_events`, `get_digest` and `review_pull_request` shipped on
 * the PLATFORM side (assembled into `AgentToolService.resolveAllowedTools`)
 * but could not exist on the web side at all: this registry is
 * manifest-driven over REST operations and there was no owner-scoped route
 * behind any of them. These specs pin all three halves of the fix — the
 * entry exists, it points at the endpoint that now exists, and it is
 * REACHABLE (a registry entry with no keyword slot is gated out of every
 * turn, which is how the Mission-create outage happened).
 */

const byName = (toolName: string) => ALL_OPERATIONS.find((op) => op.toolName === toolName);

const ALL_TOOL_NAMES = ALL_OPERATIONS.map((op) => op.toolName);

describe('the three platform tools now resolve on the web side', () => {
    it('registers list_recent_events against GET /api/ingest/events', () => {
        const op = byName('list_recent_events');
        expect(op).toBeDefined();
        expect(op).toMatchObject({ method: 'GET', path: '/api/ingest/events', kind: 'read' });
        expect(op?.params?.map((p) => p.name).sort()).toEqual(['limit', 'source', 'workId']);
        expect(op?.requiresConfirmation).toBeUndefined();
    });

    it('registers get_digest against GET /api/digest', () => {
        const op = byName('get_digest');
        expect(op).toBeDefined();
        expect(op).toMatchObject({ method: 'GET', path: '/api/digest', kind: 'read' });
        expect(op?.params?.map((p) => p.name)).toEqual(['period']);
        expect(op?.requiresConfirmation).toBeUndefined();
    });

    it('registers review_pull_request against POST /api/pr-review, behind confirmation', () => {
        const op = byName('review_pull_request');
        expect(op).toBeDefined();
        expect(op).toMatchObject({ method: 'POST', path: '/api/pr-review', kind: 'action' });
        expect(op?.body).toBe(true);
        expect(op?.bodyHint).toMatch(/owner/);
        expect(op?.bodyHint).toMatch(/prNumber/);
        // It posts a public comment and spends model credits on a diff.
        expect(op?.requiresConfirmation).toBe(true);
    });

    it('adds them exactly once each — no duplicate toolName shadowing', () => {
        for (const name of ['list_recent_events', 'get_digest', 'review_pull_request']) {
            expect(ALL_TOOL_NAMES.filter((n) => n === name)).toHaveLength(1);
        }
    });
});

describe('keyword slots ship with the tools (program DoD rule)', () => {
    it.each([
        ['what came in from github recently', 'list_recent_events'],
        ['show me the ingested events for this work', 'list_recent_events'],
        ['give me a recap of the week', 'get_digest'],
        ['what is in my daily digest', 'get_digest'],
        ['review pull request 42', 'review_pull_request'],
        ['can you look at the diff on that pull-request', 'review_pull_request'],
    ])('%j reaches %s', (text, expected) => {
        expect(selectActiveToolNames(ALL_TOOL_NAMES, { text })).toContain(expected);
    });

    it('does not leak the three tools into unrelated turns', () => {
        const selected = selectActiveToolNames(ALL_TOOL_NAMES, {
            text: 'rotate my api key',
        });
        expect(selected).not.toContain('list_recent_events');
        expect(selected).not.toContain('get_digest');
        expect(selected).not.toContain('review_pull_request');
    });
});

describe('naming convention for NEW tools', () => {
    it('is snake_case across the whole manifest, including the three added here', () => {
        const offenders = ALL_TOOL_NAMES.filter(
            (name) => !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name),
        );
        expect(offenders).toEqual([]);
    });
});
