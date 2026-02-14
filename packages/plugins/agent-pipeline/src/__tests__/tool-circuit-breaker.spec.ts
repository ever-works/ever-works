import { describe, it, expect } from 'vitest';
import { ToolCircuitBreaker } from '../utils/tool-circuit-breaker';

describe('ToolCircuitBreaker', () => {
	it('should not trip until threshold consecutive failures', () => {
		const breaker = new ToolCircuitBreaker();

		expect(breaker.recordFailure('search', new Error('fail'))).toBe(false);
		expect(breaker.isTripped('search')).toBe(false);

		expect(breaker.recordFailure('search', new Error('fail'))).toBe(false);
		expect(breaker.isTripped('search')).toBe(false);

		expect(breaker.recordFailure('search', new Error('fail'))).toBe(true);
		expect(breaker.isTripped('search')).toBe(true);
	});

	it('should reset on success while closed, but not after tripped', () => {
		const breaker = new ToolCircuitBreaker();

		breaker.recordFailure('search', new Error('fail'));
		breaker.recordFailure('search', new Error('fail'));
		breaker.recordSuccess('search');

		// Reset — need 3 more to trip
		breaker.recordFailure('search', new Error('fail'));
		breaker.recordFailure('search', new Error('fail'));
		expect(breaker.isTripped('search')).toBe(false);

		// Now trip it
		breaker.recordFailure('search', new Error('fail'));
		expect(breaker.isTripped('search')).toBe(true);

		// Success after tripped — stays tripped
		breaker.recordSuccess('search');
		expect(breaker.isTripped('search')).toBe(true);
	});

	it('should track tools independently', () => {
		const breaker = new ToolCircuitBreaker();

		breaker.recordFailure('search', new Error('fail'));
		breaker.recordFailure('search', new Error('fail'));
		breaker.recordFailure('search', new Error('fail'));

		expect(breaker.isTripped('search')).toBe(true);
		expect(breaker.isTripped('extractContent')).toBe(false);
	});

	it('should support custom threshold', () => {
		const breaker = new ToolCircuitBreaker({ threshold: 1 });

		breaker.recordFailure('search', new Error('fail'));
		expect(breaker.isTripped('search')).toBe(true);
	});

	describe('getTrippedTools', () => {
		it('should return tripped tools with the last error reason', () => {
			const breaker = new ToolCircuitBreaker();

			breaker.recordFailure('search', new Error('timeout'));
			breaker.recordFailure('search', new Error('timeout'));
			breaker.recordFailure('search', new Error('401 Unauthorized'));

			// Not enough failures to trip
			breaker.recordFailure('extractContent', new Error('fail'));

			const tripped = breaker.getTrippedTools();
			expect(tripped).toEqual([{ name: 'search', reason: '401 Unauthorized' }]);
		});

		it('should return multiple tripped tools', () => {
			const breaker = new ToolCircuitBreaker();

			for (let i = 0; i < 3; i++) {
				breaker.recordFailure('search', new Error('rate limited'));
				breaker.recordFailure('extractContent', new Error('503 Service Unavailable'));
			}

			const tripped = breaker.getTrippedTools();
			expect(tripped).toHaveLength(2);
			expect(tripped).toContainEqual({ name: 'search', reason: 'rate limited' });
			expect(tripped).toContainEqual({ name: 'extractContent', reason: '503 Service Unavailable' });
		});
	});
});
