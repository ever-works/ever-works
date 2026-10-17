import { describe, expect, it } from 'vitest';

import {
	DOMAIN_EVENT_AGGREGATE_TYPES,
	DOMAIN_EVENT_CATALOG,
	DOMAIN_EVENT_TYPES,
	domainEventEmitterName,
	getDomainEventCatalogEntry,
	isDomainEventType,
	matchesAnyDomainEventPattern,
	matchesDomainEventPattern
} from '../events/index.js';

/**
 * The domain event catalog v1 (EW-P1-1). The cross-check against the published
 * JSON catalog lives in `packages/agent` (`domain-event-contract.spec.ts`),
 * which can read the contract folder; this file pins the catalog's own rules.
 */
describe('domain event catalog v1', () => {
	it('names every type once', () => {
		expect(new Set(DOMAIN_EVENT_TYPES).size).toBe(DOMAIN_EVENT_TYPES.length);
		expect(DOMAIN_EVENT_TYPES.length).toBe(DOMAIN_EVENT_CATALOG.length);
	});

	it('uses <aggregate>.<verb> or <aggregate>.<child>.<verb> names', () => {
		for (const type of DOMAIN_EVENT_TYPES) {
			expect(type).toMatch(/^[a-z][a-z_]*(\.[a-z][a-z_]*){1,3}$/);
		}
	});

	it('points every row at a known aggregate type', () => {
		for (const entry of DOMAIN_EVENT_CATALOG) {
			expect(DOMAIN_EVENT_AGGREGATE_TYPES).toContain(entry.aggregateType);
		}
	});

	it('records the P1 types the integration needs first', () => {
		for (const type of [
			'task.created',
			'task.updated',
			'task.transitioned',
			'task.deleted',
			'task.assignee.added',
			'task.comment.created',
			'task.runtime_updated',
			'team.member.added',
			'team.resource.removed',
			'organization.member.removed',
			'agent.status_changed',
			'work.member.updated'
		]) {
			expect(getDomainEventCatalogEntry(type)?.phase).toBe('P1');
		}
	});

	it('marks child events, whose aggregate is the parent', () => {
		expect(getDomainEventCatalogEntry('task.comment.created')).toMatchObject({
			aggregateType: 'task',
			child: 'comment'
		});
		expect(getDomainEventCatalogEntry('team.member.added')).toMatchObject({
			aggregateType: 'team',
			child: 'member'
		});
		expect(getDomainEventCatalogEntry('organization.member.added')).toMatchObject({
			aggregateType: 'organization',
			child: 'member'
		});
		expect(getDomainEventCatalogEntry('task.updated')?.child).toBeUndefined();
	});

	it('answers isDomainEventType for catalog types only', () => {
		expect(isDomainEventType('task.updated')).toBe(true);
		expect(isDomainEventType('task.renamed')).toBe(false);
		expect(isDomainEventType('work.created')).toBe(true);
	});

	it('emits under domain.<type>', () => {
		expect(domainEventEmitterName('task.updated')).toBe('domain.task.updated');
	});
});

describe('matchesDomainEventPattern', () => {
	it('matches exact types', () => {
		expect(matchesDomainEventPattern('task.updated', 'task.updated')).toBe(true);
		expect(matchesDomainEventPattern('task.updated', 'task.created')).toBe(false);
	});

	it('matches a <prefix>.* wildcard at a segment boundary only', () => {
		expect(matchesDomainEventPattern('task.updated', 'task.*')).toBe(true);
		expect(matchesDomainEventPattern('task.comment.created', 'task.*')).toBe(true);
		expect(matchesDomainEventPattern('task.comment.created', 'task.comment.*')).toBe(true);
		expect(matchesDomainEventPattern('team.created', 'task.*')).toBe(false);
		// Control: a naive startsWith('task') would let this through.
		expect(matchesDomainEventPattern('taskforce.created', 'task.*')).toBe(false);
	});

	it('matches everything with *', () => {
		expect(matchesDomainEventPattern('goal.created', '*')).toBe(true);
	});

	it('delivers opt-in types only to an exact pattern', () => {
		expect(matchesDomainEventPattern('task.runtime_updated', 'task.*')).toBe(false);
		expect(matchesDomainEventPattern('task.runtime_updated', '*')).toBe(false);
		expect(matchesDomainEventPattern('task.runtime_updated', 'task.runtime_updated')).toBe(true);
	});

	it('matches any of several patterns', () => {
		expect(matchesAnyDomainEventPattern('goal.completed', ['task.*', 'goal.completed'])).toBe(true);
		expect(matchesAnyDomainEventPattern('team.created', ['task.*', 'goal.completed'])).toBe(false);
		expect(matchesAnyDomainEventPattern('team.created', [])).toBe(false);
	});
});
