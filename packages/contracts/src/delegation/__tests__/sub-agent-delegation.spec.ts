import { describe, expect, it } from 'vitest';
import {
	isSubAgentDelegationSuccessful,
	isSubAgentScopeSubset,
	narrowSubAgentScope,
	refuseSubAgentDelegation,
	validateSubAgentDelegationRequest,
	SUB_AGENT_DELEGATION_REFUSAL_CODES,
	SUB_AGENT_DELEGATION_STATUSES,
	SUB_AGENT_MAX_DELEGATION_DEPTH,
	SUB_AGENT_MAX_OBJECTIVE_CHARS,
	SUB_AGENT_MAX_SIBLING_DELEGATIONS,
	type SubAgentDelegationRequest,
	type SubAgentScope
} from '../sub-agent-delegation.types.js';

const parentScope: SubAgentScope = {
	allowedTools: ['read_file', 'write_file', 'run_tests'],
	allowedPaths: ['apps/api', 'packages/agent'],
	workId: 'work-1',
	organizationId: 'org-1',
	networkAccess: true
};

const request = (over: Partial<SubAgentDelegationRequest> = {}): SubAgentDelegationRequest => ({
	delegationId: 'del-1',
	parentAgentId: 'agent-1',
	parentRunId: 'run-1',
	depth: 0,
	objective: 'Fix the failing lint rule in packages/agent',
	scope: { allowedTools: ['read_file', 'write_file'] },
	...over
});

describe('delegation vocabularies', () => {
	it('pins the closed status set', () => {
		expect([...SUB_AGENT_DELEGATION_STATUSES].sort()).toEqual(['completed', 'escalated', 'failed', 'refused']);
	});

	it('pins the refusal codes', () => {
		expect([...SUB_AGENT_DELEGATION_REFUSAL_CODES].sort()).toEqual([
			'budget-exceeded',
			'depth-exceeded',
			'fanout-exceeded',
			'invalid-request',
			'no-runner',
			'scope-empty',
			'scope-not-subset'
		]);
	});
});

describe('narrowSubAgentScope', () => {
	it('intersects the tool allowlist — a child can never gain a tool', () => {
		const narrowed = narrowSubAgentScope(parentScope, {
			allowedTools: ['write_file', 'deploy', 'delete_repo']
		});
		expect(narrowed.allowedTools).toEqual(['write_file']);
	});

	it('inherits the parent list when the child asks for the wildcard', () => {
		expect(narrowSubAgentScope(parentScope, { allowedTools: ['*'] }).allowedTools).toEqual(
			parentScope.allowedTools
		);
	});

	it('keeps only paths under a parent prefix', () => {
		const narrowed = narrowSubAgentScope(parentScope, {
			allowedTools: ['read_file'],
			allowedPaths: ['apps/api/src', 'apps/web', 'packages/agent']
		});
		expect(narrowed.allowedPaths).toEqual(['apps/api/src', 'packages/agent']);
	});

	it('pins workId/organizationId from the parent — a child cannot hop scope', () => {
		const narrowed = narrowSubAgentScope(parentScope, {
			allowedTools: ['read_file'],
			workId: 'work-999',
			organizationId: 'org-999'
		});
		expect(narrowed.workId).toBe('work-1');
		expect(narrowed.organizationId).toBe('org-1');
	});

	it('can only turn networkAccess OFF', () => {
		expect(
			narrowSubAgentScope(parentScope, { allowedTools: ['read_file'], networkAccess: false }).networkAccess
		).toBe(false);
		expect(
			narrowSubAgentScope(
				{ allowedTools: ['*'], networkAccess: false },
				{ allowedTools: ['read_file'], networkAccess: true }
			).networkAccess
		).toBe(false);
	});
});

describe('isSubAgentScopeSubset', () => {
	it('accepts a narrowed scope and rejects a widened one', () => {
		expect(isSubAgentScopeSubset({ allowedTools: ['read_file'] }, parentScope)).toBe(false);
		expect(
			isSubAgentScopeSubset(
				{ allowedTools: ['read_file'], workId: 'work-1', organizationId: 'org-1' },
				parentScope
			)
		).toBe(true);
		expect(
			isSubAgentScopeSubset({ allowedTools: ['*'], workId: 'work-1', organizationId: 'org-1' }, parentScope)
		).toBe(false);
		expect(
			isSubAgentScopeSubset(
				{
					allowedTools: ['read_file'],
					allowedPaths: ['apps/web'],
					workId: 'work-1',
					organizationId: 'org-1'
				},
				parentScope
			)
		).toBe(false);
	});
});

describe('validateSubAgentDelegationRequest', () => {
	it('accepts a well-formed request and returns the NARROWED scope', () => {
		const result = validateSubAgentDelegationRequest(request(), { parentScope });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.request.scope.allowedTools).toEqual(['read_file', 'write_file']);
		expect(result.request.scope.workId).toBe('work-1');
	});

	it('refuses at the depth ceiling', () => {
		const result = validateSubAgentDelegationRequest(request({ depth: SUB_AGENT_MAX_DELEGATION_DEPTH }), {
			parentScope
		});
		expect(result).toMatchObject({ ok: false, refusalCode: 'depth-exceeded' });
	});

	it('refuses past the sibling fan-out cap', () => {
		const result = validateSubAgentDelegationRequest(request(), {
			parentScope,
			siblingCount: SUB_AGENT_MAX_SIBLING_DELEGATIONS
		});
		expect(result).toMatchObject({ ok: false, refusalCode: 'fanout-exceeded' });
	});

	it('refuses when narrowing leaves the child with no tools at all', () => {
		const result = validateSubAgentDelegationRequest(request({ scope: { allowedTools: ['deploy'] } }), {
			parentScope
		});
		expect(result).toMatchObject({ ok: false, refusalCode: 'scope-empty' });
	});

	it('refuses a budget above what the parent has left', () => {
		const result = validateSubAgentDelegationRequest(request({ budget: { maxCostCents: 500 } }), {
			parentScope,
			remainingCostCents: 100
		});
		expect(result).toMatchObject({ ok: false, refusalCode: 'budget-exceeded' });
	});

	it.each([
		['no delegationId', { delegationId: '' }],
		['no parentAgentId', { parentAgentId: '' }],
		['blank objective', { objective: '   ' }],
		['negative depth', { depth: -1 }],
		['over-long objective', { objective: 'x'.repeat(SUB_AGENT_MAX_OBJECTIVE_CHARS + 1) }]
	] as const)('refuses %s as invalid-request', (_label, over) => {
		const result = validateSubAgentDelegationRequest(request(over as never), { parentScope });
		expect(result).toMatchObject({ ok: false, refusalCode: 'invalid-request' });
	});

	it('validates without a parent scope (top-level delegation) and leaves the scope alone', () => {
		const result = validateSubAgentDelegationRequest(request());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.request.scope).toEqual({ allowedTools: ['read_file', 'write_file'] });
	});
});

describe('result helpers', () => {
	it('builds a canonical refusal', () => {
		expect(refuseSubAgentDelegation('del-9', 'no-runner', 'nothing bound')).toEqual({
			delegationId: 'del-9',
			status: 'refused',
			refusalCode: 'no-runner',
			summary: 'nothing bound',
			output: null
		});
	});

	it('only treats "completed" as consumable', () => {
		for (const status of SUB_AGENT_DELEGATION_STATUSES) {
			expect(
				isSubAgentDelegationSuccessful({
					delegationId: 'd',
					status,
					summary: 's',
					output: null
				})
			).toBe(status === 'completed');
		}
	});
});
