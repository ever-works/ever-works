import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	ACTIVE_SCOPE_API_HEADER,
	ACTIVE_SCOPE_BROWSER_HEADER,
	ACTIVE_SCOPE_PERSONAL_SENTINEL,
	ACTIVE_SCOPE_RESPONSE_SCHEMA,
	type ActiveScopeResponse
} from './active-scope.js';

describe('active scope response contract', () => {
	it('defines the shared runtime schema used by API documentation and consumers', () => {
		expect(ACTIVE_SCOPE_RESPONSE_SCHEMA).toEqual({
			type: 'object',
			properties: {
				tenantId: { type: 'string', format: 'uuid', nullable: true },
				organizationId: { type: 'string', format: 'uuid', nullable: true },
				organizationSlug: { type: 'string', nullable: true }
			},
			required: ['tenantId', 'organizationId', 'organizationSlug']
		});

		expectTypeOf<ActiveScopeResponse>().toEqualTypeOf<{
			tenantId: string | null;
			organizationId: string | null;
			organizationSlug: string | null;
		}>();
	});

	it('defines a reserved personal selector and canonical transport headers', () => {
		expect(ACTIVE_SCOPE_PERSONAL_SENTINEL).toBe('@personal');
		expect(ACTIVE_SCOPE_API_HEADER).toBe('x-scope-slug');
		expect(ACTIVE_SCOPE_BROWSER_HEADER).toBe('x-ever-workspace');
	});
});
