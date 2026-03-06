import { describe, it, expect } from 'vitest';
import { sanitizeResponse } from '../src/api-client/sanitize.js';

describe('sanitizeResponse', () => {
	it('strips all sensitive fields from an object', () => {
		const input = {
			id: '123',
			name: 'Test',
			password: '$2b$10$hashedpassword',
			passwordResetToken: 'reset-token',
			passwordResetExpires: '2025-01-01',
			emailVerificationToken: 'verify-token',
			emailVerificationExpires: '2025-01-01',
			lastLoginIp: '192.168.1.1'
		};
		const result = sanitizeResponse(input);
		expect(result).toEqual({ id: '123', name: 'Test' });
	});

	it('strips sensitive fields from nested objects', () => {
		const input = {
			directory: {
				id: '1',
				user: {
					id: 'u1',
					email: 'test@example.com',
					password: 'hashed',
					lastLoginIp: '10.0.0.1'
				}
			}
		};
		const result = sanitizeResponse(input);
		expect(result).toEqual({
			directory: {
				id: '1',
				user: {
					id: 'u1',
					email: 'test@example.com'
				}
			}
		});
	});

	it('handles arrays of objects', () => {
		const input = [
			{ id: '1', name: 'Dir 1', user: { password: 'hash1', email: 'a@b.com' } },
			{ id: '2', name: 'Dir 2', user: { password: 'hash2', email: 'c@d.com' } }
		];
		const result = sanitizeResponse(input);
		expect(result).toEqual([
			{ id: '1', name: 'Dir 1', user: { email: 'a@b.com' } },
			{ id: '2', name: 'Dir 2', user: { email: 'c@d.com' } }
		]);
	});

	it('returns primitives unchanged', () => {
		expect(sanitizeResponse('hello')).toBe('hello');
		expect(sanitizeResponse(42)).toBe(42);
		expect(sanitizeResponse(true)).toBe(true);
	});

	it('returns null and undefined unchanged', () => {
		expect(sanitizeResponse(null)).toBeNull();
		expect(sanitizeResponse(undefined)).toBeUndefined();
	});

	it('preserves non-sensitive fields', () => {
		const input = {
			id: '123',
			name: 'Test Directory',
			slug: 'test-dir',
			description: 'A test directory',
			createdAt: '2025-01-01',
			updatedAt: '2025-01-02'
		};
		const result = sanitizeResponse(input);
		expect(result).toEqual(input);
	});
});
