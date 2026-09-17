import { describe, expect, it } from 'vitest';
import { ALL_OPERATIONS } from './registry.all';
import { selectActiveToolNames } from '../tool-selection';

/**
 * AW-07 — chat capture of memory facts.
 *
 * "Remember that we never quote a delivery date under ten days" has to reach
 * a tool that stores it, as an ACTIVE fact, and hand the stored wording back
 * so the assistant can read it back in one line. That takes three things,
 * all pinned here: the registry entry exists and points at the real route,
 * it is not hidden behind a confirmation the person already gave by asking,
 * and it is REACHABLE — a tool without a keyword slot is gated out of every
 * turn, which is how the Mission-create outage happened.
 */

const byName = (toolName: string) => ALL_OPERATIONS.find((op) => op.toolName === toolName);
const ALL_TOOL_NAMES = ALL_OPERATIONS.map((op) => op.toolName);

describe('memory fact chat tools', () => {
    it('registers remember_fact against POST /api/memory/facts', () => {
        const op = byName('remember_fact');
        expect(op).toMatchObject({
            method: 'POST',
            path: '/api/memory/facts',
            kind: 'create',
            body: true,
        });
        expect(op?.bodyHint).toMatch(/body/);
        expect(op?.bodyHint).toMatch(/500/);
        // The person asked for it in their own turn, and every fact is
        // forgettable and restorable — a second confirmation would be noise.
        expect(op?.requiresConfirmation).toBeUndefined();
        // The tool tells the model to read the stored wording back.
        expect(op?.summary).toMatch(/read it back/i);
    });

    it('registers list_memory_facts as a read with a search parameter', () => {
        const op = byName('list_memory_facts');
        expect(op).toMatchObject({ method: 'GET', path: '/api/memory/facts', kind: 'read' });
        expect(op?.params?.map((p) => p.name)).toEqual(['q', 'status', 'limit']);
    });

    it('adds each exactly once', () => {
        for (const name of ['remember_fact', 'list_memory_facts']) {
            expect(ALL_TOOL_NAMES.filter((n) => n === name)).toHaveLength(1);
        }
    });

    it.each([
        'remember that we never quote a delivery date shorter than ten working days',
        'Remember: invoices go out on the first working day',
        'please memorize that the staging database never holds real data',
        'keep in mind that Marina approves anything over 2,000',
        "don't forget our brand name is always lowercase",
        'what do you know about our refund policy',
    ])('offers remember_fact for %j', (text) => {
        const selected = selectActiveToolNames(ALL_TOOL_NAMES, { text });
        expect(selected).toContain('remember_fact');
        expect(selected).toContain('list_memory_facts');
    });

    it.each(['rotate my api key', 'deploy the marketing site', 'create a mission for SEO'])(
        'does not offer the memory fact tools for %j',
        (text) => {
            const selected = selectActiveToolNames(ALL_TOOL_NAMES, { text });
            expect(selected).not.toContain('remember_fact');
            expect(selected).not.toContain('list_memory_facts');
        },
    );
});
