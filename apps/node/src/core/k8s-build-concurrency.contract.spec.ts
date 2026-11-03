import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(__dirname, '../../../..');
const workflowPath = join(repositoryRoot, '.github/workflows/k8s-build.yml');

/**
 * EW-758 — the prod image lane must never DISCARD a build for a deploy-bearing ref.
 *
 * `cancel-in-progress: false` (PR #2238) only governs runs that are already
 * IN PROGRESS. GitHub keeps a single PENDING run per concurrency group and a
 * newer pending run supersedes the older one regardless of that setting.
 * Observed live on this repo:
 *
 *   11:21:24Z run 32721436120 created for main 4c00e87f6 (cancel-in-progress already false)
 *   11:29:43Z run 32722136353 created for main a7b419f24
 *   11:30:28Z run 32721436120 CANCELLED — all four jobs at runner_name = "", never started
 *
 * The only structural fix is for two commits on a protected ref to land in
 * DIFFERENT concurrency groups, so neither can supersede the other at any
 * stage of its life. This contract asserts exactly that against the shipped
 * workflow, and asserts the opposite for `develop` — where sharing a group is
 * the deliberate load control and must not silently change.
 *
 * The expression is evaluated rather than pattern-matched: a test that only
 * greps for `github.sha` would pass on an expression that never reaches it.
 */

type Value = string | boolean;

interface RefContext {
	ref: string;
	sha: string;
}

interface Token {
	kind: 'string' | 'ident' | 'op' | 'lparen' | 'rparen';
	value: string;
}

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;

	while (index < source.length) {
		const char = source[index];

		if (/\s/.test(char)) {
			index += 1;
			continue;
		}
		if (char === '(') {
			tokens.push({ kind: 'lparen', value: char });
			index += 1;
			continue;
		}
		if (char === ')') {
			tokens.push({ kind: 'rparen', value: char });
			index += 1;
			continue;
		}
		if (char === "'") {
			// GitHub escapes a single quote by doubling it.
			let cursor = index + 1;
			let literal = '';
			let closed = false;
			while (cursor < source.length) {
				if (source[cursor] === "'") {
					if (source[cursor + 1] === "'") {
						literal += "'";
						cursor += 2;
						continue;
					}
					closed = true;
					break;
				}
				literal += source[cursor];
				cursor += 1;
			}
			if (!closed) {
				throw new Error(`Unterminated string literal in expression: ${source}`);
			}
			tokens.push({ kind: 'string', value: literal });
			index = cursor + 1;
			continue;
		}

		const pair = source.slice(index, index + 2);
		if (pair === '==' || pair === '!=' || pair === '&&' || pair === '||') {
			tokens.push({ kind: 'op', value: pair });
			index += 2;
			continue;
		}

		const identifier = /^[A-Za-z_][A-Za-z0-9_.\-*]*/.exec(source.slice(index));
		if (identifier) {
			tokens.push({ kind: 'ident', value: identifier[0] });
			index += identifier[0].length;
			continue;
		}

		throw new Error(`Unsupported character '${char}' in expression: ${source}`);
	}

	return tokens;
}

function isTruthy(value: Value): boolean {
	return typeof value === 'string' ? value.length > 0 : value;
}

/**
 * Deliberately throws on anything it does not model. A silently-tolerant
 * evaluator would keep reporting green after the workflow started keying the
 * group off a context this test never exercises.
 */
function resolveIdentifier(name: string, context: RefContext): Value {
	switch (name) {
		case 'github.ref':
			return context.ref;
		case 'github.sha':
			return context.sha;
		case 'true':
			return true;
		case 'false':
			return false;
		default:
			throw new Error(`Unmodelled context reference '${name}'. Extend this contract before shipping it.`);
	}
}

function parseExpression(tokens: Token[], context: RefContext): Value {
	let position = 0;

	const peek = (): Token | undefined => tokens[position];

	const parsePrimary = (): Value => {
		const token = tokens[position];
		if (!token) {
			throw new Error('Unexpected end of expression');
		}
		if (token.kind === 'lparen') {
			position += 1;
			const inner = parseOr();
			if (tokens[position]?.kind !== 'rparen') {
				throw new Error('Missing closing parenthesis');
			}
			position += 1;
			return inner;
		}
		if (token.kind === 'string') {
			position += 1;
			return token.value;
		}
		if (token.kind === 'ident') {
			position += 1;
			return resolveIdentifier(token.value, context);
		}
		throw new Error(`Unexpected token '${token.value}'`);
	};

	const parseEquality = (): Value => {
		let left = parsePrimary();
		for (;;) {
			const token = peek();
			if (token?.kind !== 'op' || (token.value !== '==' && token.value !== '!=')) {
				return left;
			}
			position += 1;
			const right = parsePrimary();
			left = token.value === '==' ? left === right : left !== right;
		}
	};

	const parseAnd = (): Value => {
		let left = parseEquality();
		for (;;) {
			const token = peek();
			if (token?.kind !== 'op' || token.value !== '&&') {
				return left;
			}
			position += 1;
			const right = parseEquality();
			// GitHub returns the operand itself, not a boolean.
			left = isTruthy(left) ? right : left;
		}
	};

	function parseOr(): Value {
		let left = parseAnd();
		for (;;) {
			const token = peek();
			if (token?.kind !== 'op' || token.value !== '||') {
				return left;
			}
			position += 1;
			const right = parseAnd();
			left = isTruthy(left) ? left : right;
		}
	}

	const result = parseOr();
	if (position !== tokens.length) {
		throw new Error(`Trailing tokens in expression starting at '${tokens[position]?.value}'`);
	}
	return result;
}

function evaluateTemplate(template: string, context: RefContext): string {
	const segments = template.split(/\$\{\{([\s\S]*?)\}\}/g);
	return segments
		.map((segment, position) => {
			if (position % 2 === 0) {
				return segment;
			}
			const value = parseExpression(tokenize(segment), context);
			return typeof value === 'string' ? value : String(value);
		})
		.join('');
}

/**
 * Reads the top-level `concurrency:` mapping out of the shipped workflow.
 * Scalars are read as single lines on purpose — this contract fails loudly if
 * someone converts them to a block scalar rather than quietly reading `>-`.
 */
async function concurrencyBlock(): Promise<{ group: string; cancelInProgress: string }> {
	const workflow = (await readFile(workflowPath, 'utf8')).replace(/\r\n/g, '\n');
	const start = workflow.indexOf('\nconcurrency:\n');
	expect(start).toBeGreaterThan(-1);

	const lines = workflow
		.slice(start + 1)
		.split('\n')
		.slice(1);
	let group: string | undefined;
	let cancelInProgress: string | undefined;

	for (const line of lines) {
		if (line.length > 0 && !line.startsWith(' ')) {
			break;
		}
		const groupMatch = /^ {2}group:\s*(\S.*)$/.exec(line);
		if (groupMatch) {
			group = groupMatch[1].trim();
		}
		const cancelMatch = /^ {2}cancel-in-progress:\s*(\S.*)$/.exec(line);
		if (cancelMatch) {
			cancelInProgress = cancelMatch[1].trim();
		}
	}

	expect(group, 'k8s-build.yml must declare concurrency.group on a single line').toBeDefined();
	expect(cancelInProgress, 'k8s-build.yml must declare concurrency.cancel-in-progress').toBeDefined();

	return { group: group as string, cancelInProgress: cancelInProgress as string };
}

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

async function groupFor(ref: string, sha: string): Promise<string> {
	const { group } = await concurrencyBlock();
	return evaluateTemplate(group, { ref, sha });
}

describe('k8s-build concurrency contract (EW-758)', () => {
	it.each([
		['refs/heads/main', 'main'],
		['refs/heads/master', 'master'],
		['refs/heads/stage', 'stage']
	])('gives two commits on %s their own group so neither can supersede the other', async (ref) => {
		const first = await groupFor(ref, SHA_A);
		const second = await groupFor(ref, SHA_B);

		expect(first).not.toBe(second);
		expect(first).toContain(SHA_A);
		expect(second).toContain(SHA_B);
	});

	it('keeps develop commits in ONE shared group, so the busy branch still self-throttles', async () => {
		const first = await groupFor('refs/heads/develop', SHA_A);
		const second = await groupFor('refs/heads/develop', SHA_B);

		expect(first).toBe(second);
		expect(first).not.toContain(SHA_A);
	});

	it('still de-duplicates a re-trigger of the SAME protected commit', async () => {
		// A workflow_dispatch on main for a commit that already has a queued push
		// run must land in that run's group: same commit, byte-identical images.
		const push = await groupFor('refs/heads/main', SHA_A);
		const dispatch = await groupFor('refs/heads/main', SHA_A);

		expect(dispatch).toBe(push);
	});

	it('never collides across refs', async () => {
		const groups = await Promise.all([
			groupFor('refs/heads/main', SHA_A),
			groupFor('refs/heads/master', SHA_A),
			groupFor('refs/heads/stage', SHA_A),
			groupFor('refs/heads/develop', SHA_A)
		]);

		expect(new Set(groups).size).toBe(groups.length);
	});

	it('keeps cancel-in-progress disabled — a RUNNING deploy build is never killed', async () => {
		const { cancelInProgress } = await concurrencyBlock();

		expect(cancelInProgress).toBe('false');
	});
});
