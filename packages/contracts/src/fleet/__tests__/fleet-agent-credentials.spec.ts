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
