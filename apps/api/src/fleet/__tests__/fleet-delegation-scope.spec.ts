import { filterToolNamesBySubAgentScope, narrowSubAgentScope } from '@ever-works/contracts';
import {
    consumeDelegationScopeClearance,
    delegationScopeNarrowsToolSurface,
    describeDelegationScopeNarrowing,
    markDelegationScopeCleared,
} from '../fleet-delegation-scope';

/**
 * Judgment layer G9 on the fleet — THE predicate behind the planner's
 * delegation-scope refusal.
 *
 * `true` means "a fleet node would have to enforce this scope, and none can",
 * so every `true` here is a delegated run the fleet refuses and every `false`
 * is a run that still routes to the fleet exactly as before. The table is
 * exhaustive over the three restricting dimensions and over the shapes the
 * `simple-json` column can hand back; an unparseable or malformed scope is
 * never read as unrestricted.
 */
describe('delegationScopeNarrowsToolSurface', () => {
    describe('not a delegated run', () => {
        it.each<[string, unknown]>([
            ['null (every ordinary dispatch)', null],
            ['undefined (a row that predates the column)', undefined],
        ])('%s narrows nothing', (_label, scope) => {
            expect(delegationScopeNarrowsToolSurface(scope)).toBe(false);
            expect(describeDelegationScopeNarrowing(scope)).toEqual([]);
        });
    });

    describe('allowedTools — reads the list the way the in-process filter does', () => {
        it.each<[string, unknown, boolean]>([
            ['absent', {}, false],
            ['non-array (string)', { allowedTools: 'readFile' }, false],
            ['non-array (null)', { allowedTools: null }, false],
            ['non-array (object)', { allowedTools: { readFile: true } }, false],
            ["the wildcard ['*']", { allowedTools: ['*'] }, false],
            [
                "a wildcard among names ['*', 'readFile']",
                { allowedTools: ['*', 'readFile'] },
                false,
            ],
            [
                "a wildcard after names ['readFile', '*']",
                { allowedTools: ['readFile', '*'] },
                false,
            ],
            ["an explicit list ['readFile']", { allowedTools: ['readFile'] }, true],
            ['an empty list [] (no tools at all)', { allowedTools: [] }, true],
        ])('%s → narrows: %s', (_label, scope, narrows) => {
            expect(delegationScopeNarrowsToolSurface(scope)).toBe(narrows);
        });

        /**
         * The fleet reads the LIST the way the platform's ONE enforcement,
         * `filterToolNamesBySubAgentScope`, reads it: that filter hands back
         * the catalog itself (same reference) exactly when the list imposes
         * no restriction, and filters otherwise. So every list the platform
         * treats as "no restriction" passes, and no list it filters by is
         * admitted. It is NOT "refuse only what withholds a tool": a concrete
         * list equal to the catalog is filtered by (and withholds nothing)
         * in-process, yet narrows here — the fleet has no catalog to compare.
         */
        it.each<[string, unknown]>([
            ['absent', undefined],
            ['string', 'readFile'],
            ['null', null],
            ['wildcard', ['*']],
            ['wildcard among names', ['*', 'readFile']],
            ['explicit list', ['readFile']],
            ['explicit list equal to the catalog', ['readFile', 'writeFile']],
            ['empty list', []],
        ])('agrees with filterToolNamesBySubAgentScope for allowedTools %s', (_label, tools) => {
            const catalog = ['readFile', 'writeFile'];
            const scope = tools === undefined ? {} : { allowedTools: tools };
            const unrestrictedInProcess =
                filterToolNamesBySubAgentScope(catalog, scope as never) === catalog;
            expect(delegationScopeNarrowsToolSurface(scope)).toBe(!unrestrictedInProcess);
        });
    });

    describe('allowedPaths — any present value narrows', () => {
        it.each<[string, unknown, boolean]>([
            ['absent', { allowedTools: ['*'] }, false],
            [
                '[] (no paths — the narrowest scope, not "unset")',
                { allowedTools: ['*'], allowedPaths: [] },
                true,
            ],
            ["['src']", { allowedTools: ['*'], allowedPaths: ['src'] }, true],
            ['null (present, malformed)', { allowedTools: ['*'], allowedPaths: null }, true],
            ['a string (malformed)', { allowedTools: ['*'], allowedPaths: 'src' }, true],
        ])('%s → narrows: %s', (_label, scope, narrows) => {
            expect(delegationScopeNarrowsToolSurface(scope)).toBe(narrows);
        });
    });

    describe('networkAccess — anything but absent or true narrows', () => {
        it.each<[string, unknown, boolean]>([
            ['absent', { allowedTools: ['*'] }, false],
            ['true', { allowedTools: ['*'], networkAccess: true }, false],
            ['false', { allowedTools: ['*'], networkAccess: false }, true],
            ['null (read as off)', { allowedTools: ['*'], networkAccess: null }, true],
            ["the string 'false'", { allowedTools: ['*'], networkAccess: 'false' }, true],
            ['0', { allowedTools: ['*'], networkAccess: 0 }, true],
        ])('%s → narrows: %s', (_label, scope, narrows) => {
            expect(delegationScopeNarrowsToolSurface(scope)).toBe(narrows);
        });
    });

    describe('scope keys that do not touch the tool surface', () => {
        it('ignores workId / organizationId on an otherwise unrestricted scope', () => {
            expect(
                delegationScopeNarrowsToolSurface({
                    allowedTools: ['*'],
                    workId: 'work-1',
                    organizationId: 'org-1',
                    networkAccess: true,
                }),
            ).toBe(false);
        });
    });

    describe('the scopes real delegations persist', () => {
        it('narrows the scope the delegateToAgent tool produces (parent list, child asks for *)', () => {
            // agent-tool.service.ts: the parent scope is the parent's REAL
            // tool names, the request is ['*'], and narrowing turns the
            // wildcard into a copy of the parent's concrete list.
            const persisted = narrowSubAgentScope(
                {
                    allowedTools: ['readFile', 'writeFile', 'commitToRepo'],
                    workId: 'work-1',
                    organizationId: null,
                    networkAccess: true,
                },
                {
                    allowedTools: ['*'],
                    workId: 'work-1',
                    organizationId: null,
                    networkAccess: true,
                },
            );
            expect(persisted.allowedTools).toEqual(['readFile', 'writeFile', 'commitToRepo']);
            expect(delegationScopeNarrowsToolSurface(persisted)).toBe(true);
        });

        it('narrows a parent without canCallExternalTools on networkAccess alone', () => {
            const persisted = narrowSubAgentScope(
                { allowedTools: ['*'], networkAccess: false },
                { allowedTools: ['*'], networkAccess: false },
            );
            expect(persisted.allowedTools).toEqual(['*']);
            expect(describeDelegationScopeNarrowing(persisted)).toEqual(['networkAccess off']);
        });
    });

    describe('a scope that arrives as a JSON string', () => {
        it.each<[string, string, boolean]>([
            ['an unrestricted object', '{"allowedTools":["*"]}', false],
            [
                'an unrestricted object with networkAccess true',
                '{"allowedTools":["*"],"networkAccess":true}',
                false,
            ],
            ['an explicit tool list', '{"allowedTools":["readFile"]}', true],
            ['networkAccess false', '{"allowedTools":["*"],"networkAccess":false}', true],
            ['allowedPaths', '{"allowedTools":["*"],"allowedPaths":["src"]}', true],
        ])('is parsed: %s → narrows: %s', (_label, scope, narrows) => {
            expect(delegationScopeNarrowsToolSurface(scope)).toBe(narrows);
        });

        it.each<[string, string]>([
            ['truncated JSON', '{"allowedTools":["*"'],
            ['not JSON at all', 'allowedTools=*'],
            ['the empty string', ''],
        ])('fails closed on unparseable text (%s)', (_label, scope) => {
            expect(delegationScopeNarrowsToolSurface(scope)).toBe(true);
            expect(describeDelegationScopeNarrowing(scope)).toEqual(['scope is not valid JSON']);
        });

        it.each<[string, string]>([
            ['null', 'null'],
            ['an array', '["*"]'],
            ['a number', '42'],
            ['a double-encoded object', JSON.stringify(JSON.stringify({ allowedTools: ['*'] }))],
        ])('fails closed on JSON that does not decode to an object (%s)', (_label, scope) => {
            expect(delegationScopeNarrowsToolSurface(scope)).toBe(true);
        });
    });

    describe('a scope that is not an object at all', () => {
        it.each<[string, unknown]>([
            ['a number', 42],
            ['a boolean', true],
            ['an array', ['*']],
        ])('fails closed on %s', (_label, scope) => {
            expect(delegationScopeNarrowsToolSurface(scope)).toBe(true);
        });
    });
});

describe('describeDelegationScopeNarrowing', () => {
    it('names every narrowing dimension, in a stable order', () => {
        expect(
            describeDelegationScopeNarrowing({
                allowedTools: ['readFile'],
                allowedPaths: ['src', 'docs'],
                networkAccess: false,
            }),
        ).toEqual(['allowedTools [readFile]', 'allowedPaths [src, docs]', 'networkAccess off']);
    });

    it('spells out the empty lists instead of printing a bare []', () => {
        expect(describeDelegationScopeNarrowing({ allowedTools: [], allowedPaths: [] })).toEqual([
            'allowedTools [] (no tools)',
            'allowedPaths [] (no paths)',
        ]);
    });

    it('bounds a long tool list so a refusal message stays readable', () => {
        const tools = Array.from({ length: 30 }, (_, index) => `tool${index}`);
        expect(describeDelegationScopeNarrowing({ allowedTools: tools })).toEqual([
            'allowedTools [tool0, tool1, tool2, tool3, tool4, tool5, tool6, tool7, +22 more]',
        ]);
    });
});

/**
 * The one-shot clearance the fleet-aware dispatcher hands the router's job
 * writer after the G9 guard admitted a payload. The router refuses any
 * payload without one, so it must be tied to the exact object, spent by the
 * first write, and impossible to obtain any other way than being marked.
 */
describe('delegation-scope clearance (dispatcher to job writer)', () => {
    const payload = () => ({ taskId: 'task-1', runId: 'run-1', dedupKey: 'task-1:agent-1:1' });

    it('is absent for a payload nobody cleared', () => {
        expect(consumeDelegationScopeClearance(payload())).toBe(false);
    });

    it('is granted exactly once for the payload object that was cleared', () => {
        const cleared = payload();
        markDelegationScopeCleared(cleared);

        expect(consumeDelegationScopeClearance(cleared)).toBe(true);
        expect(consumeDelegationScopeClearance(cleared)).toBe(false);
    });

    it('belongs to that object, not to an equal copy of it', () => {
        const cleared = payload();
        markDelegationScopeCleared(cleared);

        expect(consumeDelegationScopeClearance({ ...cleared })).toBe(false);
        expect(consumeDelegationScopeClearance(payload())).toBe(false);
        // The copies spent nothing: the original is still cleared.
        expect(consumeDelegationScopeClearance(cleared)).toBe(true);
    });
});
