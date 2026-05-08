import { describe, it, expect, beforeEach } from 'vitest';
import { HealthController } from '../src/health.controller.js';

describe('HealthController', () => {
	let controller: HealthController;

	beforeEach(() => {
		controller = new HealthController();
	});

	it('GET /health returns { status: "ok" }', () => {
		expect(controller.health()).toEqual({ status: 'ok' });
	});

	it('returns a fresh object on every call (no shared state)', () => {
		const a = controller.health();
		const b = controller.health();
		expect(a).not.toBe(b);
		expect(a).toEqual(b);
	});

	it('is synchronous (must not return a Promise)', () => {
		const result = controller.health();
		expect(result).not.toBeInstanceOf(Promise);
	});
});
