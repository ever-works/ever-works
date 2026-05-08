import { describe, expect, it } from 'vitest';
import { substituteVariables } from '../template.utils.js';

describe('substituteVariables', () => {
	it('returns the template unchanged when variables is undefined', () => {
		const tpl = 'Hello {name}!';
		expect(substituteVariables(tpl)).toBe(tpl);
	});

	it('returns the template unchanged when variables is an empty object (typed loose)', () => {
		const tpl = 'Hello {name}, you are {age}';
		// Cast through unknown to bypass the typed-template constraint —
		// we are intentionally exercising the runtime "key missing" path.
		const result = substituteVariables(tpl, {} as unknown as { name: string; age: string });
		// Both placeholders should remain since neither key is supplied.
		expect(result).toBe('Hello {name}, you are {age}');
	});

	it('substitutes single placeholder', () => {
		const result = substituteVariables('Hello {name}!', { name: 'Ada' });
		expect(result).toBe('Hello Ada!');
	});

	it('substitutes multiple placeholders', () => {
		const result = substituteVariables('Hello {name}, you are {age}', {
			name: 'Ada',
			age: '30'
		});
		expect(result).toBe('Hello Ada, you are 30');
	});

	it('repeats the same placeholder when used multiple times', () => {
		const result = substituteVariables('{x}-{x}-{x}', { x: 'a' });
		expect(result).toBe('a-a-a');
	});

	it('leaves unmatched placeholders intact when a key is missing', () => {
		const result = substituteVariables('Hello {name}, age {age}', {
			// `age` is missing on purpose
			name: 'Ada'
		} as unknown as { name: string; age: string });
		expect(result).toBe('Hello Ada, age {age}');
	});

	it('treats explicit empty string as a substitution (not "missing")', () => {
		const result = substituteVariables('a={a}b', { a: '' });
		expect(result).toBe('a=b');
	});

	it('only matches the {word} pattern — leaves dotted/dashed/spaced placeholders untouched', () => {
		const tpl = '{a.b} {a-b} {a b}';
		const result = substituteVariables(tpl, { ab: 'X' } as unknown as Record<string, string>);
		// None of the three placeholder shapes match `\w+`, so the template is untouched.
		expect(result).toBe(tpl);
	});

	it('substitutes underscore and digit identifiers (\\w covers [A-Za-z0-9_])', () => {
		const result = substituteVariables('{var_1} and {VAR2}', {
			var_1: 'one',
			VAR2: 'two'
		} as unknown as Record<string, string>);
		expect(result).toBe('one and two');
	});

	it('returns the empty string for an empty template', () => {
		expect(substituteVariables('', { foo: 'bar' } as unknown as Record<string, string>)).toBe('');
	});

	it('does not substitute when the value is undefined', () => {
		const result = substituteVariables('hi {name}', {
			name: undefined as unknown as string
		});
		expect(result).toBe('hi {name}');
	});
});
