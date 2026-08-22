import { describe, expect, it } from 'vitest';

import {
	FLEET_AGENT_CREDENTIAL_ENV_NAMES,
	FLEET_AGENT_CREDENTIAL_FAMILIES,
	resolveExclusiveAgentCredentials
} from '../fleet-agent-credentials.types.js';

const ALL = [...FLEET_AGENT_CREDENTIAL_ENV_NAMES];

describe('FLEET_AGENT_CREDENTIAL_FAMILIES', () => {
	it('lists the subscription-backed credential before the per-token one', () => {
		// The whole safety property depends on this order: the first name
		// present wins, so the cheaper credential must come first.
		for (const family of FLEET_AGENT_CREDENTIAL_FAMILIES) {
			expect(family.envNames.length).toBeGreaterThan(1);
		}
		const claude = FLEET_AGENT_CREDENTIAL_FAMILIES.find((f) => f.cli === 'claude-code');
		expect(claude?.envNames[0]).toBe('CLAUDE_CODE_OAUTH_TOKEN');
		expect(claude?.envNames).toContain('ANTHROPIC_API_KEY');

		const codex = FLEET_AGENT_CREDENTIAL_FAMILIES.find((f) => f.cli === 'codex');
		expect(codex?.envNames[0]).toBe('CODEX_ACCESS_TOKEN');
		expect(codex?.envNames).toContain('OPENAI_API_KEY');
	});
});

describe('resolveExclusiveAgentCredentials', () => {
	it('keeps a lone credential untouched', () => {
		const { names, notes } = resolveExclusiveAgentCredentials(ALL, {
			CLAUDE_CODE_OAUTH_TOKEN: 'oauth'
		});
		expect(names).toContain('CLAUDE_CODE_OAUTH_TOKEN');
		expect(notes).toEqual([]);
	});

	it('drops the API key when a subscription token is also set on the node', () => {
		// The regression this exists for: Claude Code would otherwise resolve
		// ANTHROPIC_API_KEY (higher precedence, always used under -p) and bill
		// the Console org for a run the operator meant to be on their plan.
		const { names, notes } = resolveExclusiveAgentCredentials(ALL, {
			CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
			ANTHROPIC_API_KEY: 'sk-key'
		});
		expect(names).toContain('CLAUDE_CODE_OAUTH_TOKEN');
		expect(names).not.toContain('ANTHROPIC_API_KEY');
		expect(notes.join(' ')).toMatch(/claude-code.*CLAUDE_CODE_OAUTH_TOKEN.*ANTHROPIC_API_KEY/);
	});

	it('drops OPENAI_API_KEY when a Codex workspace access token is set', () => {
		const { names } = resolveExclusiveAgentCredentials(ALL, {
			CODEX_ACCESS_TOKEN: 'ctk',
			OPENAI_API_KEY: 'sk-openai'
		});
		expect(names).toContain('CODEX_ACCESS_TOKEN');
		expect(names).not.toContain('OPENAI_API_KEY');
	});

	it('resolves each CLI family independently', () => {
		const { names } = resolveExclusiveAgentCredentials(ALL, {
			CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
			ANTHROPIC_API_KEY: 'sk-key',
			OPENAI_API_KEY: 'sk-openai'
		});
		// Claude resolved down to the token; Codex has only one present, so
		// the API key survives in its own family.
		expect(names).toContain('CLAUDE_CODE_OAUTH_TOKEN');
		expect(names).not.toContain('ANTHROPIC_API_KEY');
		expect(names).toContain('OPENAI_API_KEY');
	});

	it('keeps the API key when it is the only credential the node has', () => {
		const { names, notes } = resolveExclusiveAgentCredentials(ALL, { ANTHROPIC_API_KEY: 'sk-key' });
		expect(names).toContain('ANTHROPIC_API_KEY');
		expect(notes).toEqual([]);
	});

	it('ignores a variable that is set but empty', () => {
		// An exported-but-blank var must not out-rank a real credential.
		const { names } = resolveExclusiveAgentCredentials(ALL, {
			CLAUDE_CODE_OAUTH_TOKEN: '   ',
			ANTHROPIC_API_KEY: 'sk-key'
		});
		expect(names).toContain('ANTHROPIC_API_KEY');
	});

	it('passes through names outside any known family', () => {
		const { names } = resolveExclusiveAgentCredentials([...ALL, 'MY_WRAPPER_TOKEN'], {
			MY_WRAPPER_TOKEN: 'x',
			CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
			ANTHROPIC_API_KEY: 'sk-key'
		});
		expect(names).toContain('MY_WRAPPER_TOKEN');
	});

	it('does not drop a credential the caller never granted', () => {
		// Only ANTHROPIC_API_KEY was granted; the token being present in the
		// environment must not suppress it, because it was never passed on.
		const { names } = resolveExclusiveAgentCredentials(['ANTHROPIC_API_KEY'], {
			CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
			ANTHROPIC_API_KEY: 'sk-key'
		});
		expect(names).toEqual(['ANTHROPIC_API_KEY']);
	});
});

describe('FLEET_AGENT_CREDENTIAL_FAMILIES — membership', () => {
	it('covers exactly two CLIs', () => {
		// Count guard: a third family added without a matching test would
		// otherwise ship an unasserted drop order.
		expect(FLEET_AGENT_CREDENTIAL_FAMILIES).toHaveLength(2);
		expect(FLEET_AGENT_CREDENTIAL_FAMILIES.map((family) => family.cli)).toEqual(['claude-code', 'codex']);
	});

	it('pins the full env-name list of each family in preference order', () => {
		const byCli = new Map(FLEET_AGENT_CREDENTIAL_FAMILIES.map((family) => [family.cli, family.envNames]));
		expect(byCli.get('claude-code')).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
		expect(byCli.get('codex')).toEqual(['CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY']);
	});

	it('names each CLI once', () => {
		const clis = FLEET_AGENT_CREDENTIAL_FAMILIES.map((family) => family.cli);
		expect(new Set(clis).size).toBe(clis.length);
	});

	it('never lists one env name in two families', () => {
		// A name in two families would make the drop order ambiguous: the first
		// family to process it would win, silently, by array position.
		const names = FLEET_AGENT_CREDENTIAL_FAMILIES.flatMap((family) => [...family.envNames]);
		expect(new Set(names).size).toBe(names.length);
	});
});

describe('FLEET_AGENT_CREDENTIAL_ENV_NAMES', () => {
	it('lists all four credential names in family order', () => {
		expect(FLEET_AGENT_CREDENTIAL_ENV_NAMES).toEqual([
			'CLAUDE_CODE_OAUTH_TOKEN',
			'ANTHROPIC_API_KEY',
			'CODEX_ACCESS_TOKEN',
			'OPENAI_API_KEY'
		]);
	});

	it('has exactly four unique members', () => {
		expect(FLEET_AGENT_CREDENTIAL_ENV_NAMES).toHaveLength(4);
		expect(new Set(FLEET_AGENT_CREDENTIAL_ENV_NAMES).size).toBe(4);
	});

	it('stays derived from the families', () => {
		// This list is the default `envPassthrough` grant. Pinning the derivation
		// means a family edited without regenerating the list cannot ship a
		// grant that no longer matches the drop rules applied to it.
		expect(FLEET_AGENT_CREDENTIAL_ENV_NAMES).toEqual(
			FLEET_AGENT_CREDENTIAL_FAMILIES.flatMap((family) => [...family.envNames])
		);
	});
});

describe('resolveExclusiveAgentCredentials — remaining branches', () => {
	it('returns empty results for an empty grant', () => {
		expect(resolveExclusiveAgentCredentials([], { CLAUDE_CODE_OAUTH_TOKEN: 'oauth' })).toEqual({
			names: [],
			notes: []
		});
	});

	it('drops EVERY copy of a duplicated loser', () => {
		// The final filter is by VALUE, not by index, so a caller that granted
		// the same name twice does not smuggle one copy through.
		const { names } = resolveExclusiveAgentCredentials(
			['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
			{ CLAUDE_CODE_OAUTH_TOKEN: 'oauth', ANTHROPIC_API_KEY: 'sk-key' }
		);
		expect(names).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
	});

	it.each([
		['an empty string', ''],
		['undefined', undefined],
		['whitespace only', '\t\n  ']
	])('treats a value of %s as absent', (_label, value) => {
		// `(env[name] ?? '').trim() !== ''` — an exported-but-blank variable is
		// not a credential, so it must not out-rank a real one or trigger a note.
		const { names, notes } = resolveExclusiveAgentCredentials(ALL, {
			CLAUDE_CODE_OAUTH_TOKEN: value,
			ANTHROPIC_API_KEY: 'sk-key'
		});
		expect(names).toContain('ANTHROPIC_API_KEY');
		expect(notes).toEqual([]);
		// The blank name is still PASSED THROUGH rather than filtered out: this
		// function only drops a loser, and granting a name a machine does not
		// set is a no-op. Pinned so nobody mistakes the grant list for a
		// "credentials this node has" list.
		expect(names).toEqual([...ALL]);
	});

	it('preserves the CALLER order, not the family order', () => {
		// The result is the granted list filtered, so a wrapper name keeps its
		// place between two credential names instead of being re-sorted.
		const granted = ['OPENAI_API_KEY', 'MY_WRAPPER', 'CLAUDE_CODE_OAUTH_TOKEN'];
		const { names } = resolveExclusiveAgentCredentials(granted, {
			OPENAI_API_KEY: 'sk-openai',
			MY_WRAPPER: 'x',
			CLAUDE_CODE_OAUTH_TOKEN: 'oauth'
		});
		expect(names).toEqual(['OPENAI_API_KEY', 'MY_WRAPPER', 'CLAUDE_CODE_OAUTH_TOKEN']);
	});

	it('emits one note per family when both families drop at once', () => {
		const { names, notes } = resolveExclusiveAgentCredentials(ALL, {
			CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
			ANTHROPIC_API_KEY: 'sk-key',
			CODEX_ACCESS_TOKEN: 'ctk',
			OPENAI_API_KEY: 'sk-openai'
		});
		expect(names).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_ACCESS_TOKEN']);
		expect(notes).toHaveLength(2);
		expect(notes[0]).toContain('claude-code');
		expect(notes[0]).toContain('using CLAUDE_CODE_OAUTH_TOKEN');
		expect(notes[0]).toContain('ignoring ANTHROPIC_API_KEY');
		expect(notes[1]).toContain('codex');
		expect(notes[1]).toContain('using CODEX_ACCESS_TOKEN');
		expect(notes[1]).toContain('ignoring OPENAI_API_KEY');
	});

	it('returns a fresh names array the caller may mutate', () => {
		// `Array.prototype.filter` always allocates, so the granted list a
		// caller keeps around is never aliased by the result.
		const granted = ['ANTHROPIC_API_KEY'];
		const { names } = resolveExclusiveAgentCredentials(granted, { ANTHROPIC_API_KEY: 'sk-key' });
		expect(names).not.toBe(granted);
		names.push('MUTATED');
		expect(granted).toEqual(['ANTHROPIC_API_KEY']);
	});
});
