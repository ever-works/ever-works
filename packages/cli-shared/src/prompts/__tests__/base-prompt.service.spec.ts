import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BasePromptService } from '../base-prompt.service.js';

// Test subclass that exposes protected members so we can exercise them
// without going through inquirer (interactive prompts are mocked separately).
class TestPromptService extends BasePromptService {
	public exposeDisplaySectionHeader = (t: string) => this.displaySectionHeader(t);
	public exposeDisplayInfo = (m: string) => this.displayInfo(m);
	public exposeDisplaySuccess = (m: string) => this.displaySuccess(m);
	public exposeDisplayWarning = (m: string) => this.displayWarning(m);
	public exposeDisplayError = (m: string) => this.displayError(m);

	public exposeValidateUrl = (u: string) => this.validateUrl(u);
	public exposeValidateEmail = (e: string) => this.validateEmail(e);
	public exposeValidateGitUsername = (u: string) => this.validateGitUsername(u);
	public exposeValidateApiKey = (k: string) => this.validateApiKey(k);
	public exposeValidateApiKeyWithProvider = (k: string, p: string) => this.validateApiKeyWithProvider(k, p);
	public exposeValidateModelName = (m: string) => this.validateModelName(m);
	public exposeValidateSlug = (s: string) => this.validateSlug(s);
	public exposeValidateTemperature = (t: number) => this.validateTemperature(t);
	public exposeValidateMaxTokens = (n: number) => this.validateMaxTokens(n);
	public exposeValidateGitName = (n: string) => this.validateGitName(n);
	public exposeSlugifyName = (n: string) => this.slugifyName(n);
}

describe('BasePromptService — display helpers', () => {
	let svc: TestPromptService;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		svc = new TestPromptService();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it('displaySectionHeader prints the title', () => {
		svc.exposeDisplaySectionHeader('Auth');
		const out = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
		expect(out).toMatch(/Auth/);
	});

	it('displayInfo / displaySuccess / displayWarning / displayError each call console.log once', () => {
		svc.exposeDisplayInfo('hello');
		svc.exposeDisplaySuccess('ok');
		svc.exposeDisplayWarning('careful');
		svc.exposeDisplayError('bad');
		expect(logSpy).toHaveBeenCalledTimes(4);
		const out = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
		expect(out).toMatch(/hello/);
		expect(out).toMatch(/ok/);
		expect(out).toMatch(/careful/);
		expect(out).toMatch(/bad/);
	});
});

describe('BasePromptService — validateUrl', () => {
	const svc = new TestPromptService();

	it('accepts http and https URLs', () => {
		expect(svc.exposeValidateUrl('https://example.com')).toBe(true);
		expect(svc.exposeValidateUrl('http://example.com/path?q=1')).toBe(true);
	});

	it('rejects malformed URLs with a helpful message', () => {
		const r = svc.exposeValidateUrl('not-a-url');
		expect(typeof r).toBe('string');
		expect(r as string).toMatch(/valid URL/);
	});

	it('rejects empty string', () => {
		expect(svc.exposeValidateUrl('')).not.toBe(true);
	});
});

describe('BasePromptService — validateEmail', () => {
	const svc = new TestPromptService();

	it('accepts a typical email address', () => {
		expect(svc.exposeValidateEmail('alice@example.com')).toBe(true);
	});

	it('rejects strings without @ or domain', () => {
		expect(svc.exposeValidateEmail('alice')).not.toBe(true);
		expect(svc.exposeValidateEmail('@example.com')).not.toBe(true);
		expect(svc.exposeValidateEmail('alice@')).not.toBe(true);
	});

	it('rejects strings missing the dot in domain', () => {
		expect(svc.exposeValidateEmail('alice@example')).not.toBe(true);
	});
});

describe('BasePromptService — validateGitUsername', () => {
	const svc = new TestPromptService();

	it('accepts typical alphanumeric usernames and hyphens', () => {
		expect(svc.exposeValidateGitUsername('alice')).toBe(true);
		expect(svc.exposeValidateGitUsername('alice-bob')).toBe(true);
		expect(svc.exposeValidateGitUsername('user123')).toBe(true);
	});

	it('rejects empty username', () => {
		expect(svc.exposeValidateGitUsername('')).not.toBe(true);
	});

	it('rejects username with > 39 characters', () => {
		expect(svc.exposeValidateGitUsername('a'.repeat(40))).not.toBe(true);
	});

	it('rejects usernames starting or ending with a hyphen', () => {
		expect(svc.exposeValidateGitUsername('-alice')).not.toBe(true);
		expect(svc.exposeValidateGitUsername('alice-')).not.toBe(true);
	});

	it('rejects usernames with disallowed characters', () => {
		// The regex permits a single trailing _segment ("alice_bob" matches),
		// but dots and spaces are never allowed.
		expect(svc.exposeValidateGitUsername('alice.bob')).not.toBe(true);
		expect(svc.exposeValidateGitUsername('alice bob')).not.toBe(true);
		expect(svc.exposeValidateGitUsername('alice@home')).not.toBe(true);
	});
});

describe('BasePromptService — validateApiKey', () => {
	const svc = new TestPromptService();

	it('accepts a 32-character key', () => {
		expect(svc.exposeValidateApiKey('a'.repeat(32))).toBe(true);
	});

	it('rejects too-short keys (<10 chars)', () => {
		const r = svc.exposeValidateApiKey('short');
		expect(typeof r).toBe('string');
		expect(r as string).toMatch(/too short/);
	});

	it('rejects too-long keys (>200 chars)', () => {
		const r = svc.exposeValidateApiKey('a'.repeat(201));
		expect(typeof r).toBe('string');
		expect(r as string).toMatch(/too long/);
	});
});

describe('BasePromptService — validateApiKeyWithProvider', () => {
	const svc = new TestPromptService();

	it('accepts a reasonable key for the given provider', () => {
		expect(svc.exposeValidateApiKeyWithProvider('abcdef12345', 'OpenAI')).toBe(true);
	});

	it('rejects a key that is too short and includes provider name in the error', () => {
		const r = svc.exposeValidateApiKeyWithProvider('abcd', 'Anthropic');
		expect(typeof r).toBe('string');
		expect(r as string).toMatch(/Anthropic/);
		expect(r as string).toMatch(/too short/);
	});

	it('rejects keys containing spaces', () => {
		const r = svc.exposeValidateApiKeyWithProvider('abcdef abcdef', 'OpenAI');
		expect(typeof r).toBe('string');
		expect(r as string).toMatch(/should not contain spaces/);
	});
});

describe('BasePromptService — validateModelName', () => {
	const svc = new TestPromptService();

	it('accepts typical AI model names', () => {
		expect(svc.exposeValidateModelName('gpt-4')).toBe(true);
		expect(svc.exposeValidateModelName('claude-3-opus')).toBe(true);
		expect(svc.exposeValidateModelName('provider/model-name')).toBe(true);
		expect(svc.exposeValidateModelName('claude.3.5_sonnet')).toBe(true);
	});

	it('rejects names that are too short', () => {
		expect(svc.exposeValidateModelName('a')).not.toBe(true);
	});

	it('rejects names that are too long (>100)', () => {
		expect(svc.exposeValidateModelName('a'.repeat(101))).not.toBe(true);
	});

	it('rejects names with disallowed characters', () => {
		expect(svc.exposeValidateModelName('foo bar')).not.toBe(true);
		expect(svc.exposeValidateModelName('foo!bar')).not.toBe(true);
	});
});

describe('BasePromptService — validateSlug', () => {
	const svc = new TestPromptService();

	it('accepts a simple slug', () => {
		expect(svc.exposeValidateSlug('hello-world')).toBe(true);
		expect(svc.exposeValidateSlug('ab')).toBe(true);
	});

	it('rejects too-short slugs', () => {
		const r = svc.exposeValidateSlug('a');
		expect(typeof r).toBe('string');
		expect(r as string).toMatch(/at least 2/);
	});

	it('rejects too-long slugs (>50)', () => {
		const r = svc.exposeValidateSlug('a'.repeat(51));
		expect(typeof r).toBe('string');
		expect(r as string).toMatch(/less than 50/);
	});

	it('rejects uppercase or non-allowed chars', () => {
		expect(svc.exposeValidateSlug('Hello-World')).not.toBe(true);
		expect(svc.exposeValidateSlug('hello_world')).not.toBe(true);
		expect(svc.exposeValidateSlug('hello world')).not.toBe(true);
	});

	it('rejects slugs starting/ending with hyphen', () => {
		expect(svc.exposeValidateSlug('-hello')).not.toBe(true);
		expect(svc.exposeValidateSlug('hello-')).not.toBe(true);
	});

	it('rejects slugs with consecutive hyphens', () => {
		const r = svc.exposeValidateSlug('hello--world');
		expect(typeof r).toBe('string');
		expect(r as string).toMatch(/consecutive hyphens/);
	});
});

describe('BasePromptService — validateTemperature', () => {
	const svc = new TestPromptService();

	it('accepts values in the [0, 2] range', () => {
		expect(svc.exposeValidateTemperature(0)).toBe(true);
		expect(svc.exposeValidateTemperature(0.7)).toBe(true);
		expect(svc.exposeValidateTemperature(2)).toBe(true);
	});

	it('rejects values below 0', () => {
		expect(svc.exposeValidateTemperature(-0.1)).not.toBe(true);
	});

	it('rejects values above 2', () => {
		expect(svc.exposeValidateTemperature(2.5)).not.toBe(true);
	});
});

describe('BasePromptService — validateMaxTokens', () => {
	const svc = new TestPromptService();

	it('accepts integers in the valid range', () => {
		expect(svc.exposeValidateMaxTokens(1)).toBe(true);
		expect(svc.exposeValidateMaxTokens(4096)).toBe(true);
		expect(svc.exposeValidateMaxTokens(200000)).toBe(true);
	});

	it('rejects values below 1', () => {
		expect(svc.exposeValidateMaxTokens(0)).not.toBe(true);
	});

	it('rejects values above 200,000', () => {
		expect(svc.exposeValidateMaxTokens(200001)).not.toBe(true);
	});

	it('rejects non-integer values', () => {
		const r = svc.exposeValidateMaxTokens(4096.5);
		expect(typeof r).toBe('string');
		expect(r as string).toMatch(/whole number/);
	});
});

describe('BasePromptService — validateGitName', () => {
	const svc = new TestPromptService();

	it('accepts typical names', () => {
		expect(svc.exposeValidateGitName('Alice')).toBe(true);
		expect(svc.exposeValidateGitName("Mary O'Hara")).toBe(true);
		expect(svc.exposeValidateGitName('Jean-Luc Picard')).toBe(true);
		expect(svc.exposeValidateGitName('Dr. Watson')).toBe(true);
	});

	it('rejects names that are too short', () => {
		expect(svc.exposeValidateGitName('A')).not.toBe(true);
	});

	it('rejects names that are too long', () => {
		expect(svc.exposeValidateGitName('A'.repeat(101))).not.toBe(true);
	});

	it('rejects names with disallowed characters', () => {
		expect(svc.exposeValidateGitName('Alice123')).not.toBe(true);
		expect(svc.exposeValidateGitName('Alice@home')).not.toBe(true);
	});
});

describe('BasePromptService — slugifyName', () => {
	const svc = new TestPromptService();

	it('lowercases input and replaces whitespace with hyphens', () => {
		expect(svc.exposeSlugifyName('Hello World')).toBe('hello-world');
	});

	it('strips disallowed characters', () => {
		expect(svc.exposeSlugifyName('Hello, World! 2026?')).toBe('hello-world-2026');
	});

	it('collapses consecutive hyphens', () => {
		expect(svc.exposeSlugifyName('hello---world')).toBe('hello-world');
	});

	it('trims leading and trailing hyphens', () => {
		expect(svc.exposeSlugifyName('  -- hello -- ')).toBe('hello');
	});

	it('returns empty string for input with only special characters', () => {
		expect(svc.exposeSlugifyName('!!!')).toBe('');
	});
});
