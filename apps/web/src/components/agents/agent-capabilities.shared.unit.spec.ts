import { describe, expect, it } from 'vitest';
import type {
    AgentCapabilityToolRow,
    AgentStoredToolGrant,
    ToolGrantChainEntry,
} from '@ever-works/contracts';
import { composeGrantForToggle, toolToggleState } from './agent-capabilities.shared';

/**
 * Capabilities tab — tool-switch policy.
 *
 * These are the assertions that keep the switch honest: it must be
 * disabled exactly when this page cannot change the outcome, and the row
 * it PUTs must be the one that actually produces the outcome the user
 * clicked for.
 */

function tool(over: Partial<AgentCapabilityToolRow> = {}): AgentCapabilityToolRow {
    return {
        name: 'searchWeb',
        description: 'Web search.',
        gatedByPermission: null,
        source: 'facade',
        permissionEnabled: true,
        decision: { allowed: true, toolName: 'searchWeb', source: 'default' },
        effective: true,
        ...over,
    };
}

function denied(source: ToolGrantChainEntry['scope'], code: 'tool-denied' | 'tool-not-granted') {
    return tool({
        decision: { allowed: false, toolName: 'searchWeb', source, code },
        effective: false,
    });
}

const layer = (over: Partial<ToolGrantChainEntry>): ToolGrantChainEntry => ({
    scope: 'default',
    id: null,
    allow: ['*'],
    deny: [],
    rejected: [],
    ...over,
});

const DEFAULT_CHAIN: ToolGrantChainEntry[] = [layer({})];

const row = (over: Partial<AgentStoredToolGrant> = {}): AgentStoredToolGrant => ({
    id: 'row-1',
    allow: null,
    deny: null,
    note: null,
    ...over,
});

describe('toolToggleState', () => {
    it('is editable+on for a tool the matrix allows', () => {
        expect(toolToggleState(tool(), null, DEFAULT_CHAIN)).toEqual({
            kind: 'editable',
            checked: true,
        });
    });

    it('reports permission-off before anything else (Settings owns that flag)', () => {
        const state = toolToggleState(
            tool({ gatedByPermission: 'canCallExternalTools', permissionEnabled: false }),
            null,
            DEFAULT_CHAIN,
        );
        expect(state).toEqual({ kind: 'permission-off', permission: 'canCallExternalTools' });
    });

    it('locks a tool an ANCESTOR layer denies, naming the most specific such layer', () => {
        const chain = [
            layer({}),
            layer({ scope: 'tenant', id: 't1', allow: [], deny: ['search*'] }),
            layer({ scope: 'organization', id: 'o1', allow: [], deny: ['searchWeb'] }),
        ];
        expect(toolToggleState(denied('organization', 'tool-denied'), null, chain)).toEqual({
            kind: 'upstream-denied',
            scope: 'organization',
        });
    });

    it('an ancestor deny outranks a redundant agent-level deny', () => {
        const chain = [
            layer({}),
            layer({ scope: 'work', id: 'w1', allow: [], deny: ['searchWeb'] }),
            layer({ scope: 'agent', id: 'a1', allow: [], deny: ['searchWeb'] }),
        ];
        const state = toolToggleState(
            denied('work', 'tool-denied'),
            row({ deny: ['searchWeb'] }),
            chain,
        );
        expect(state).toEqual({ kind: 'upstream-denied', scope: 'work' });
    });

    it('is editable+off when the AGENT row denies the exact tool name', () => {
        const chain = [
            layer({}),
            layer({ scope: 'agent', id: 'a1', allow: [], deny: ['searchWeb'] }),
        ];
        expect(
            toolToggleState(denied('agent', 'tool-denied'), row({ deny: ['searchWeb'] }), chain),
        ).toEqual({ kind: 'editable', checked: false });
    });

    it('matches the agent deny case-insensitively (patterns are case-insensitive)', () => {
        const chain = [
            layer({}),
            layer({ scope: 'agent', id: 'a1', allow: [], deny: ['SEARCHWEB'] }),
        ];
        expect(
            toolToggleState(denied('agent', 'tool-denied'), row({ deny: ['SEARCHWEB'] }), chain),
        ).toEqual({ kind: 'editable', checked: false });
    });

    it('reports pattern-denied for a WILDCARD agent deny (a switch cannot express it)', () => {
        const chain = [
            layer({}),
            layer({ scope: 'agent', id: 'a1', allow: [], deny: ['search*'] }),
        ];
        expect(
            toolToggleState(denied('agent', 'tool-denied'), row({ deny: ['search*'] }), chain),
        ).toEqual({
            kind: 'pattern-denied',
        });
    });

    /**
     * The regression this module exists for: a `tool-not-granted` refusal
     * attributes to 'default' (no allow list matched), so keying the
     * switch off `decision.source === 'agent'` would disable a control
     * over a restriction the agent row itself owns.
     */
    it('is editable+off when the AGENT allow list merely omits the tool', () => {
        const chain = [
            layer({}),
            layer({ scope: 'agent', id: 'a1', allow: ['createTask'], deny: [] }),
        ];
        const state = toolToggleState(
            denied('default', 'tool-not-granted'),
            row({ allow: ['createTask'] }),
            chain,
        );
        expect(state).toEqual({ kind: 'editable', checked: false });
    });

    it('locks a tool an ANCESTOR allow list never granted (no widening from here)', () => {
        const chain = [
            layer({ allow: ['*'] }),
            layer({ scope: 'work', id: 'w1', allow: ['createTask'], deny: [] }),
        ];
        expect(toolToggleState(denied('default', 'tool-not-granted'), null, chain)).toEqual({
            kind: 'upstream-denied',
            scope: 'default',
        });
    });
});

describe('composeGrantForToggle', () => {
    it('OFF adds the exact tool name to the deny list', () => {
        expect(composeGrantForToggle(tool(), null, false)).toEqual({ deny: ['searchWeb'] });
    });

    it('OFF never duplicates a deny that already covers the tool', () => {
        expect(composeGrantForToggle(tool(), row({ deny: ['search*'] }), false)).toEqual({
            deny: ['search*'],
        });
    });

    it('OFF re-sends the stored allow list unchanged (PUT replaces the row)', () => {
        expect(
            composeGrantForToggle(tool(), row({ allow: ['searchWeb', 'createTask'] }), false),
        ).toEqual({
            allow: ['searchWeb', 'createTask'],
            deny: ['searchWeb'],
        });
    });

    it('ON removes the exact deny entry', () => {
        expect(
            composeGrantForToggle(tool(), row({ deny: ['searchWeb', 'createTask'] }), true),
        ).toEqual({ deny: ['createTask'] });
    });

    it('ON also ADDS the tool to a stored allow list that omits it', () => {
        expect(
            composeGrantForToggle(tool(), row({ allow: ['createTask'], deny: [] }), true),
        ).toEqual({
            allow: ['createTask', 'searchWeb'],
            deny: [],
        });
    });

    it('ON leaves an allow list that already covers the tool alone', () => {
        expect(
            composeGrantForToggle(tool(), row({ allow: ['search*'], deny: ['searchWeb'] }), true),
        ).toEqual({ allow: ['search*'], deny: [] });
    });

    /**
     * Regression: the API writes `note = body.note ?? null` on every PUT,
     * so a toggle that omits the note DELETES the operator's rationale for
     * the whole grant row. Both directions must carry it.
     */
    it('re-sends the stored note so a toggle cannot destroy it', () => {
        const stored = row({ deny: ['createTask'], note: 'SOC2: no direct external calls' });
        expect(composeGrantForToggle(tool(), stored, false)).toEqual({
            deny: ['createTask', 'searchWeb'],
            note: 'SOC2: no direct external calls',
        });
        expect(composeGrantForToggle(tool(), stored, true)).toEqual({
            deny: ['createTask'],
            note: 'SOC2: no direct external calls',
        });
    });

    it('omits note entirely when the row carries none (never writes an empty note)', () => {
        expect(composeGrantForToggle(tool(), row({ note: null }), false)).not.toHaveProperty(
            'note',
        );
        expect(composeGrantForToggle(tool(), null, false)).not.toHaveProperty('note');
    });

    it('never mutates the stored row', () => {
        const stored = row({ allow: ['createTask'], deny: ['x'] });
        composeGrantForToggle(tool(), stored, true);
        composeGrantForToggle(tool(), stored, false);
        expect(stored.allow).toEqual(['createTask']);
        expect(stored.deny).toEqual(['x']);
    });
});
