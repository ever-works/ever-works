import { describe, it, expect } from 'vitest';
import { DomainType } from '../index.js';

describe('DomainType enum', () => {
	it('exposes the four expected string values', () => {
		expect(DomainType.SOFTWARE).toBe('software');
		expect(DomainType.ECOMMERCE).toBe('ecommerce');
		expect(DomainType.SERVICES).toBe('services');
		expect(DomainType.GENERAL).toBe('general');
	});

	it('has exactly 4 members (catches accidental additions/removals)', () => {
		// String enums emit one entry per member; no reverse-mapping noise.
		expect(Object.keys(DomainType)).toEqual(
			expect.arrayContaining(['SOFTWARE', 'ECOMMERCE', 'SERVICES', 'GENERAL'])
		);
		expect(Object.keys(DomainType)).toHaveLength(4);
	});
});
