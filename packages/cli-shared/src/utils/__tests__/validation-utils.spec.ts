import { describe, it, expect } from 'vitest';
import {
	validateUrl,
	validateEmail,
	validateGitUsername,
	validateApiKey,
	validateModelName
} from '../validation-utils.js';

describe('validateUrl', () => {
	it('accepts well-formed http and https URLs', () => {
		expect(validateUrl('https://example.com')).toEqual({ isValid: true });
		expect(validateUrl('http://example.com/path?query=1')).toEqual({ isValid: true });
	});

	it('rejects invalid URLs with a helpful message', () => {
		const r = validateUrl('not-a-url');
		expect(r.isValid).toBe(false);
		expect(r.error).toMatch(/valid URL/);
	});

	it('rejects empty string', () => {
		expect(validateUrl('').isValid).toBe(false);
	});
});

describe('validateEmail', () => {
	it('accepts a typical email address', () => {
		expect(validateEmail('alice@example.com')).toEqual({ isValid: true });
	});

	it('rejects strings without @ or domain', () => {
		expect(validateEmail('alice').isValid).toBe(false);
		expect(validateEmail('alice@example').isValid).toBe(false);
		expect(validateEmail('@example.com').isValid).toBe(false);
	});
});

describe('validateGitUsername', () => {
	it('accepts a typical username', () => {
		expect(validateGitUsername('alice')).toEqual({ isValid: true });
		expect(validateGitUsername('alice-bob')).toEqual({ isValid: true });
	});

	it('rejects empty and overlong usernames', () => {
		expect(validateGitUsername('').isValid).toBe(false);
		expect(validateGitUsername('a'.repeat(40)).isValid).toBe(false);
	});

	it('rejects usernames starting/ending with a hyphen', () => {
		expect(validateGitUsername('-alice').isValid).toBe(false);
		expect(validateGitUsername('alice-').isValid).toBe(false);
	});
});

describe('validateApiKey', () => {
	it('accepts a key with reasonable length', () => {
		expect(validateApiKey('a'.repeat(32))).toEqual({ isValid: true });
	});

	it('rejects too-short keys', () => {
		expect(validateApiKey('short').isValid).toBe(false);
	});

	it('rejects too-long keys', () => {
		expect(validateApiKey('a'.repeat(201)).isValid).toBe(false);
	});
});

describe('validateModelName', () => {
	it('accepts typical AI provider model names', () => {
		expect(validateModelName('gpt-4')).toEqual({ isValid: true });
		expect(validateModelName('claude-3-opus')).toEqual({ isValid: true });
		expect(validateModelName('provider/model-name')).toEqual({ isValid: true });
		expect(validateModelName('claude.3.5_sonnet')).toEqual({ isValid: true });
	});

	it('rejects too short and too long names', () => {
		expect(validateModelName('a').isValid).toBe(false);
		expect(validateModelName('a'.repeat(101)).isValid).toBe(false);
	});

	it('rejects names with disallowed characters', () => {
		expect(validateModelName('foo bar').isValid).toBe(false);
		expect(validateModelName('foo!bar').isValid).toBe(false);
	});
});
