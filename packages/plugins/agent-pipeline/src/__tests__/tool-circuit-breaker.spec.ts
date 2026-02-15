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

		breaker.recordFailure('search', new Error('fail'));
		breaker.recordFailure('search', new Error('fail'));
		expect(breaker.isTripped('search')).toBe(false);

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

	describe('getFailedTools', () => {
		it('should return tools with failures below threshold', () => {
			const breaker = new ToolCircuitBreaker();

			breaker.recordFailure('search', new Error('401 Unauthorized'));
			breaker.recordFailure('search', new Error('401 Unauthorized'));

			expect(breaker.isTripped('search')).toBe(false);
			expect(breaker.getFailedTools()).toEqual([{ name: 'search', reason: '401 Unauthorized' }]);
		});

		it('should include both tripped and non-tripped tools', () => {
			const breaker = new ToolCircuitBreaker();

			breaker.recordFailure('search', new Error('401'));
			breaker.recordFailure('search', new Error('401'));
			breaker.recordFailure('search', new Error('401'));
			breaker.recordFailure('extractContent', new Error('timeout'));

			const failed = breaker.getFailedTools();
			expect(failed).toHaveLength(2);
			expect(failed).toContainEqual({ name: 'search', reason: '401' });
			expect(failed).toContainEqual({ name: 'extractContent', reason: 'timeout' });
		});

		it('should not include tools that recovered', () => {
			const breaker = new ToolCircuitBreaker();

			breaker.recordFailure('search', new Error('timeout'));
			breaker.recordSuccess('search');

			expect(breaker.getFailedTools()).toHaveLength(0);
		});
	});
});
