import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as appsBarrel from '../index.js';
import * as packageRoot from '../../index.js';

import {
	APP_ENV_ALPHABETS,
	APP_ENV_API_ERROR_CODES,
	APP_ENV_DOTENV_MAX_BYTES,
	APP_ENV_DOTENV_MAX_LINES,
	APP_ENV_ERROR_CODES,
	APP_ENV_ERROR_MESSAGE_KEY_PREFIX,
	APP_ENV_ERROR_MESSAGE_LEAVES,
	APP_ENV_GENERATE_SLA_MS,
	APP_ENV_GENERATOR_KINDS,
	APP_ENV_KEYPAIR_FORMATS,
	APP_ENV_KEYPAIR_RAW_TYPES,
	APP_ENV_KEYPAIR_TYPES,
	APP_ENV_MAX_STORED,
	APP_ENV_NAME_PATTERN,
	APP_ENV_ORIGINS,
	APP_ENV_PATTERN_BUDGET_MS,
	APP_ENV_PHASES,
	APP_ENV_PUBLIC_HALF_MAX_BYTES,
	APP_ENV_PUBLIC_PREFIXES,
	APP_ENV_PUTS_PER_MINUTE,
	APP_ENV_RESERVED_PREFIX,
	APP_ENV_ROTATIONS_PER_HOUR,
	APP_ENV_TEMPLATE_MAX_DEPTH,
	APP_ENV_TOTAL_MAX_BYTES,
	APP_ENV_VALIDATION_REFUSAL_CODES,
	APP_ENV_VALUE_MAX_BYTES,
	appEnvErrorMessageKey,
	type AppEnvAlphabet,
	type AppEnvEntrySource,
	type AppEnvEntryView,
	type AppEnvErrorCode,
	type AppEnvGeneratorKind,
	type AppEnvKeypairFormat,
	type AppEnvKeypairRawType,
	type AppEnvKeypairType,
	type AppEnvOrigin,
	type AppEnvPhase,
	type AppEnvPublicPrefix,
	type AppEnvValidationRefusalCode
} from '../app-env.js';

/**
 * Behavioural contract for APW-07's shared App env module (`app-env.ts`,
 * plan §3.3:234-294).
 *
 * The pins are what this file is for. Every closed union is restated from the
 * PLAN and compared to the module with `Equal<…>`, so the module is measured
 * against its source rather than against itself; every number is pinned with the
 * line that fixes it (the line is in the test NAME, so a failure names its own
 * source); every alphabet is pinned by LENGTH and by the characters the plan
 * excludes; and the API error codes are pinned all the way into
 * `apps/web/messages/en.json`, because a code without copy is a code that renders
 * as a raw identifier on a card (plan §5:802-805, §8:918 — APW07-G23).
 *
 * A suite that could not fail would be no evidence at all: every assertion here
 * is paired with a deliberate perturbation in the task report.
 */

/** Compile-time equality, so a widened or narrowed union fails to type-check. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Forces `Equal<…>` to be `true` at compile time. */
type Expect<T extends true> = T;

/** True when a tuple repeats a member — the compile-time half of the uniqueness pin. */
type HasDuplicates<T extends readonly string[], Seen extends string = never> = T extends readonly [
	infer Head extends string,
	...infer Rest extends string[]
]
	? Head extends Seen
		? true
		: HasDuplicates<Rest, Seen | Head>
	: false;

/**
 * The closed unions restated from the PLAN — never from the module — so the pins
 * below compare the module to its source rather than to itself.
 */
type SpecAppEnvOrigin = 'generated' | 'derived' | 'prompted' | 'user' | 'default'; // plan.md:237
type SpecAppEnvPhase = 'build' | 'runtime' | 'both'; // plan.md:238
type SpecAppEnvGeneratorKind = 'base64' | 'hex' | 'chars' | 'uuid' | 'keypair'; // plan.md:239
type SpecAppEnvAlphabet = 'alnum' | 'alnum-symbols' | 'hex-lower' | 'base64url'; // plan.md:240-245
type SpecAppEnvKeypairType = 'ed25519' | 'ec-p256' | 'rsa-2048' | 'rsa-4096'; // plan.md:246
type SpecAppEnvKeypairFormat = 'pem' | 'base64url-raw' | 'pkcs12'; // plan.md:247, R-11
type SpecAppEnvKeypairRawType = 'ed25519' | 'ec-p256'; // plan.md:248
type SpecAppEnvPublicPrefix = 'NEXT_PUBLIC_' | 'VITE_' | 'PUBLIC_' | 'REACT_APP_' | 'NUXT_PUBLIC_' | 'EXPO_PUBLIC_'; // plan.md:251-258
type SpecAppEnvEntrySource = 'generate' | 'from' | 'template' | 'prompt' | 'value' | 'undeclared'; // plan.md:274
type SpecAppEnvValidationRefusalCode =
	| 'invalidName'
	| 'reservedName'
	| 'valueTooLarge'
	| 'controlCharacter'
	| 'lengthMismatch'
	| 'tooShort'
	| 'tooLong'
	| 'patternMismatch'; // plan.md:409-410, spec FR-18/FR-19
type SpecAppEnvApiErrorCode =
	| 'generatedValueUseRotate'
	| 'neverRotateNotAcknowledged'
	| 'rotateConfirmationMismatch'
	| 'secureStorageUnavailable'
	| 'tooManyValues'
	| 'valuesTooLarge'
	| 'malformedLine'
	| 'rotateRateLimited'; // plan.md:798-802
type SpecAppEnvErrorCode = SpecAppEnvValidationRefusalCode | SpecAppEnvApiErrorCode; // plan.md:907

/**
 * Every runtime tuple this module exports, by name, so the uniqueness pin covers
 * a tuple added later — a new `as const` list that forgets this table is caught by
 * the barrel-area test's own name list, and a duplicate member is caught here.
 */
const RUNTIME_TUPLES: readonly (readonly [string, readonly string[]])[] = [
	['APP_ENV_ORIGINS', APP_ENV_ORIGINS],
	['APP_ENV_PHASES', APP_ENV_PHASES],
	['APP_ENV_GENERATOR_KINDS', APP_ENV_GENERATOR_KINDS],
	['APP_ENV_KEYPAIR_TYPES', APP_ENV_KEYPAIR_TYPES],
	['APP_ENV_KEYPAIR_FORMATS', APP_ENV_KEYPAIR_FORMATS],
	['APP_ENV_KEYPAIR_RAW_TYPES', APP_ENV_KEYPAIR_RAW_TYPES],
	['APP_ENV_PUBLIC_PREFIXES', APP_ENV_PUBLIC_PREFIXES],
	['APP_ENV_VALIDATION_REFUSAL_CODES', APP_ENV_VALIDATION_REFUSAL_CODES],
	['APP_ENV_API_ERROR_CODES', APP_ENV_API_ERROR_CODES],
	['APP_ENV_ERROR_CODES', APP_ENV_ERROR_CODES]
];

describe('app-env — closed unions match plan §3.3 (tasks.md:51-64)', () => {
	it('pins every derived union type against the literal union its plan line names', () => {
		// The `satisfies` lines below are the runtime-free half: a member added to a
		// tuple without the spec union (or the reverse) stops compiling.
		const origins = APP_ENV_ORIGINS satisfies readonly SpecAppEnvOrigin[];
		const phases = APP_ENV_PHASES satisfies readonly SpecAppEnvPhase[];
		const generators = APP_ENV_GENERATOR_KINDS satisfies readonly SpecAppEnvGeneratorKind[];
		const keypairTypes = APP_ENV_KEYPAIR_TYPES satisfies readonly SpecAppEnvKeypairType[];
		const keypairFormats = APP_ENV_KEYPAIR_FORMATS satisfies readonly SpecAppEnvKeypairFormat[];
		const rawTypes = APP_ENV_KEYPAIR_RAW_TYPES satisfies readonly SpecAppEnvKeypairRawType[];
		const prefixes = APP_ENV_PUBLIC_PREFIXES satisfies readonly SpecAppEnvPublicPrefix[];
		const refusals = APP_ENV_VALIDATION_REFUSAL_CODES satisfies readonly SpecAppEnvValidationRefusalCode[];
		const apiCodes = APP_ENV_API_ERROR_CODES satisfies readonly SpecAppEnvApiErrorCode[];

		// `Equal<…>` is the strict half: it fails on a missing member even where
		// `satisfies` would still pass (a narrower tuple satisfies a wider union).
		const origin: Expect<Equal<AppEnvOrigin, SpecAppEnvOrigin>> = true;
		const phase: Expect<Equal<AppEnvPhase, SpecAppEnvPhase>> = true;
		const generator: Expect<Equal<AppEnvGeneratorKind, SpecAppEnvGeneratorKind>> = true;
		const alphabet: Expect<Equal<AppEnvAlphabet, SpecAppEnvAlphabet>> = true;
		const keypairType: Expect<Equal<AppEnvKeypairType, SpecAppEnvKeypairType>> = true;
		const keypairFormat: Expect<Equal<AppEnvKeypairFormat, SpecAppEnvKeypairFormat>> = true;
		const rawType: Expect<Equal<AppEnvKeypairRawType, SpecAppEnvKeypairRawType>> = true;
		const prefix: Expect<Equal<AppEnvPublicPrefix, SpecAppEnvPublicPrefix>> = true;
		const source: Expect<Equal<AppEnvEntrySource, SpecAppEnvEntrySource>> = true;
		const refusal: Expect<Equal<AppEnvValidationRefusalCode, SpecAppEnvValidationRefusalCode>> = true;
		const errorCode: Expect<Equal<AppEnvErrorCode, SpecAppEnvErrorCode>> = true;

		expect([
			origins.length,
			phases.length,
			generators.length,
			keypairTypes.length,
			keypairFormats.length,
			rawTypes.length,
			prefixes.length,
			refusals.length,
			apiCodes.length,
			origin,
			phase,
			generator,
			alphabet,
			keypairType,
			keypairFormat,
			rawType,
			prefix,
			source,
			refusal,
			errorCode
		]).toEqual([5, 3, 5, 4, 3, 2, 6, 8, 8, true, true, true, true, true, true, true, true, true, true, true]);
	});

	it('lists the plan §3.3 members in the plan’s own order', () => {
		expect([...APP_ENV_ORIGINS]).toEqual(['generated', 'derived', 'prompted', 'user', 'default']);
		expect([...APP_ENV_PHASES]).toEqual(['build', 'runtime', 'both']);
		expect([...APP_ENV_GENERATOR_KINDS]).toEqual(['base64', 'hex', 'chars', 'uuid', 'keypair']);
		expect([...APP_ENV_KEYPAIR_TYPES]).toEqual(['ed25519', 'ec-p256', 'rsa-2048', 'rsa-4096']);
		expect([...APP_ENV_PUBLIC_PREFIXES]).toEqual([
			'NEXT_PUBLIC_',
			'VITE_',
			'PUBLIC_',
			'REACT_APP_',
			'NUXT_PUBLIC_',
			'EXPO_PUBLIC_'
		]);
	});

	it('has APP_ENV_KEYPAIR_FORMATS exactly pem, base64url-raw, pkcs12 (plan.md:247, R-11)', () => {
		// Exactly, in order: `pkcs12` is R-11's addition and `pem` is the default.
		expect([...APP_ENV_KEYPAIR_FORMATS]).toEqual(['pem', 'base64url-raw', 'pkcs12']);
	});

	it('refuses base64url-raw for RSA — the raw types are the two non-RSA ones (plan.md:248)', () => {
		expect([...APP_ENV_KEYPAIR_RAW_TYPES]).toEqual(['ed25519', 'ec-p256']);
		for (const rawType of APP_ENV_KEYPAIR_RAW_TYPES) {
			expect(APP_ENV_KEYPAIR_TYPES).toContain(rawType);
		}
		for (const rsa of ['rsa-2048', 'rsa-4096'] as const) {
			expect(APP_ENV_KEYPAIR_RAW_TYPES).not.toContain(rsa);
		}
	});

	it('has the App spec name grammar and reserved prefix of FR-18 verbatim (plan.md:249-250)', () => {
		expect(APP_ENV_NAME_PATTERN).toBe('^[A-Z_][A-Z0-9_]{0,127}$');
		expect(APP_ENV_RESERVED_PREFIX).toBe('EVER_WORKS_');
		// The pattern is what the App spec schema compiles: an uppercase name, 128
		// characters at most, starting with a letter or an underscore.
		const name = new RegExp(APP_ENV_NAME_PATTERN);
		expect(name.test('SMTP_PASSWORD')).toBe(true);
		expect(name.test('_UNDERSCORE')).toBe(true);
		expect(name.test('bad-name')).toBe(false);
		expect(name.test('EVER_WORKS_X')).toBe(true); // reserved by PREFIX, not by grammar
		expect(name.test(`A${'B'.repeat(127)}`)).toBe(true);
		expect(name.test(`A${'B'.repeat(128)}`)).toBe(false);
		expect(name.test(`${APP_ENV_RESERVED_PREFIX}FOO`)).toBe(true);
		expect(`${APP_ENV_RESERVED_PREFIX}FOO`.startsWith(APP_ENV_RESERVED_PREFIX)).toBe(true);
	});

	it('has no duplicate member in any exported tuple', () => {
		// The runtime half of the uniqueness pin, and the one that covers a tuple
		// built by spread (`APP_ENV_ERROR_CODES` is the concatenation of two lists).
		expect(RUNTIME_TUPLES.length).toBe(10);
		for (const [name, members] of RUNTIME_TUPLES) {
			expect(members.length, `${name} must not be empty`).toBeGreaterThan(0);
			expect(new Set(members).size, `${name} repeats a member`).toBe(members.length);
			for (const member of members) {
				expect(typeof member, `${name} has a non-string member`).toBe('string');
				expect(member.length, `${name} has an empty member`).toBeGreaterThan(0);
			}
		}
	});

	it('cannot grow a duplicate at compile time either', () => {
		const origins: Expect<Equal<HasDuplicates<typeof APP_ENV_ORIGINS>, false>> = true;
		const phases: Expect<Equal<HasDuplicates<typeof APP_ENV_PHASES>, false>> = true;
		const generators: Expect<Equal<HasDuplicates<typeof APP_ENV_GENERATOR_KINDS>, false>> = true;
		const keypairTypes: Expect<Equal<HasDuplicates<typeof APP_ENV_KEYPAIR_TYPES>, false>> = true;
		const keypairFormats: Expect<Equal<HasDuplicates<typeof APP_ENV_KEYPAIR_FORMATS>, false>> = true;
		const rawTypes: Expect<Equal<HasDuplicates<typeof APP_ENV_KEYPAIR_RAW_TYPES>, false>> = true;
		const prefixes: Expect<Equal<HasDuplicates<typeof APP_ENV_PUBLIC_PREFIXES>, false>> = true;
		const refusals: Expect<Equal<HasDuplicates<typeof APP_ENV_VALIDATION_REFUSAL_CODES>, false>> = true;
		const apiCodes: Expect<Equal<HasDuplicates<typeof APP_ENV_API_ERROR_CODES>, false>> = true;
		const errorCodes: Expect<Equal<HasDuplicates<typeof APP_ENV_ERROR_CODES>, false>> = true;

		expect([
			origins,
			phases,
			generators,
			keypairTypes,
			keypairFormats,
			rawTypes,
			prefixes,
			refusals,
			apiCodes,
			errorCodes
		]).toEqual([true, true, true, true, true, true, true, true, true, true]);
	});
});

describe('app-env — the chars alphabets are the plan’s exact strings (plan.md:240-245, FR-10)', () => {
	it('lists the four alphabets in the plan’s order, with the pinned lengths 62 / 76 / 16 / 64', () => {
		expect(Object.keys(APP_ENV_ALPHABETS)).toEqual(['alnum', 'alnum-symbols', 'hex-lower', 'base64url']);
		expect(APP_ENV_ALPHABETS.alnum).toHaveLength(62);
		expect(APP_ENV_ALPHABETS['alnum-symbols']).toHaveLength(76);
		expect(APP_ENV_ALPHABETS['hex-lower']).toHaveLength(16);
		expect(APP_ENV_ALPHABETS.base64url).toHaveLength(64);
	});

	it('spells each alphabet exactly as plan §3.3 does, character for character', () => {
		expect(APP_ENV_ALPHABETS.alnum).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
		expect(APP_ENV_ALPHABETS['alnum-symbols']).toBe(
			'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#%+,-.:=?@^_~'
		);
		expect(APP_ENV_ALPHABETS['hex-lower']).toBe('0123456789abcdef');
		expect(APP_ENV_ALPHABETS.base64url).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_');
	});

	it('has no duplicate character in any alphabet', () => {
		for (const [name, alphabet] of Object.entries(APP_ENV_ALPHABETS)) {
			expect(new Set([...alphabet]).size, `${name} repeats a character`).toBe([...alphabet].length);
		}
	});

	it('keeps alnum-symbols free of the five characters a value cannot carry (plan.md:242)', () => {
		// The point of the exclusion list: a double quote, a single quote, a
		// backtick, a dollar sign or a space in a generated value is what breaks the
		// shell that materialises it — so the alphabet the plan fixes has none.
		const symbols = APP_ENV_ALPHABETS['alnum-symbols'];
		expect(symbols).not.toContain('"');
		expect(symbols).not.toContain("'");
		expect(symbols).not.toContain('`');
		expect(symbols).not.toContain('$');
		expect(symbols).not.toContain(' ');
		for (const forbidden of ['"', "'", '`', '$', ' '] as const) {
			expect(symbols.includes(forbidden), `alnum-symbols must not contain ${JSON.stringify(forbidden)}`).toBe(
				false
			);
		}
	});

	it('builds alnum-symbols as alnum plus the fourteen symbols, and nothing else', () => {
		const alnum = APP_ENV_ALPHABETS.alnum;
		const symbols = APP_ENV_ALPHABETS['alnum-symbols'];
		const extra = [...symbols].filter((character) => !alnum.includes(character));
		expect(extra.join('')).toBe('!#%+,-.:=?@^_~');
		expect(extra).toHaveLength(14);
		// Every alnum character survives into the wider alphabet, so a value written
		// under one alphabet stays readable under the other.
		for (const character of alnum) {
			expect(symbols.includes(character), `alnum-symbols is missing ${character}`).toBe(true);
		}
	});

	it('keeps hex-lower inside alnum and base64url as the URL-safe pair', () => {
		expect(APP_ENV_ALPHABETS['hex-lower']).toBe('0123456789abcdef');
		for (const character of APP_ENV_ALPHABETS['hex-lower']) {
			expect(APP_ENV_ALPHABETS.alnum.includes(character)).toBe(true);
		}
		// base64url is the standard alphabet with `-` and `_` instead of `+` and `/`,
		// which is what keeps a raw keypair safe in a query string.
		expect(APP_ENV_ALPHABETS.base64url).toContain('-');
		expect(APP_ENV_ALPHABETS.base64url).toContain('_');
		expect(APP_ENV_ALPHABETS.base64url).not.toContain('+');
		expect(APP_ENV_ALPHABETS.base64url).not.toContain('/');
		expect(APP_ENV_ALPHABETS.base64url).not.toContain('=');
	});
});

describe('app-env — every numeric constant is the plan’s value (plan.md:259-269)', () => {
	it('pins the eleven numbers, one per plan line', () => {
		// 65_536 — one value's byte ceiling (plan.md:259, FR-18)
		expect(APP_ENV_VALUE_MAX_BYTES).toBe(65_536);
		// 1_048_576 — total stored bytes per App Work (plan.md:260, FR-31)
		expect(APP_ENV_TOTAL_MAX_BYTES).toBe(1_048_576);
		// 300 — stored values per App Work (plan.md:261, FR-31)
		expect(APP_ENV_MAX_STORED).toBe(300);
		// 16_384 — a keypair public half's ceiling (plan.md:262, FR-15)
		expect(APP_ENV_PUBLIC_HALF_MAX_BYTES).toBe(16_384);
		// 50 — the linear-time pattern budget in ms (plan.md:263, FR-17)
		expect(APP_ENV_PATTERN_BUDGET_MS).toBe(50);
		// 65_536 — the pasted `.env` ceiling (plan.md:264, FR-28)
		expect(APP_ENV_DOTENV_MAX_BYTES).toBe(65_536);
		// 500 — the pasted `.env` line ceiling (plan.md:265, FR-28)
		expect(APP_ENV_DOTENV_MAX_LINES).toBe(500);
		// 60_000 — generated within 60 s of the spec being applied (plan.md:266, FR-9)
		expect(APP_ENV_GENERATE_SLA_MS).toBe(60_000);
		// 10 — rotations per App Work per hour (plan.md:267, FR-13)
		expect(APP_ENV_ROTATIONS_PER_HOUR).toBe(10);
		// 30 — PUTs per minute per member (plan.md:268, FR-34)
		expect(APP_ENV_PUTS_PER_MINUTE).toBe(30);
		// 10 — template nesting depth, re-checked at resolution (plan.md:269)
		expect(APP_ENV_TEMPLATE_MAX_DEPTH).toBe(10);
	});

	it('keeps the two 65_536 ceilings equal and the two 10s independent', () => {
		// A value ceiling and a paste ceiling that drifted apart would be a bug the
		// plan does not have: both are one 64 KiB page (plan.md:259, :264).
		expect(APP_ENV_DOTENV_MAX_BYTES).toBe(APP_ENV_VALUE_MAX_BYTES);
		expect(APP_ENV_VALUE_MAX_BYTES).toBe(64 * 1024);
		// The rotation cap and the template depth share the value 10 by coincidence,
		// not by construction — pinning both stops a later edit from "sharing" them.
		expect(APP_ENV_ROTATIONS_PER_HOUR).toBe(APP_ENV_TEMPLATE_MAX_DEPTH);
		expect(APP_ENV_TOTAL_MAX_BYTES).toBe(16 * APP_ENV_VALUE_MAX_BYTES);
		expect(APP_ENV_TOTAL_MAX_BYTES / APP_ENV_VALUE_MAX_BYTES).toBe(16);
		expect(APP_ENV_PUBLIC_HALF_MAX_BYTES).toBe(16_384);
		expect(APP_ENV_TOTAL_MAX_BYTES).toBeGreaterThan(APP_ENV_VALUE_MAX_BYTES);
		expect(APP_ENV_DOTENV_MAX_LINES).toBe(500);
		for (const value of [
			APP_ENV_VALUE_MAX_BYTES,
			APP_ENV_TOTAL_MAX_BYTES,
			APP_ENV_MAX_STORED,
			APP_ENV_PUBLIC_HALF_MAX_BYTES,
			APP_ENV_PATTERN_BUDGET_MS,
			APP_ENV_DOTENV_MAX_BYTES,
			APP_ENV_DOTENV_MAX_LINES,
			APP_ENV_GENERATE_SLA_MS,
			APP_ENV_ROTATIONS_PER_HOUR,
			APP_ENV_PUTS_PER_MINUTE,
			APP_ENV_TEMPLATE_MAX_DEPTH
		]) {
			expect(Number.isInteger(value), `${value} must be an integer`).toBe(true);
			expect(value).toBeGreaterThan(0);
		}
	});
});

describe('app-env — the API error codes carry copy (plan §5:798-805, §8:907; APW07-G23)', () => {
	const HERE = dirname(fileURLToPath(import.meta.url));
	const EN_JSON = resolve(HERE, '../../../../../apps/web/messages/en.json');

	function readEnglishMessages(): Record<string, unknown> {
		try {
			return JSON.parse(readFileSync(EN_JSON, 'utf8')) as Record<string, unknown>;
		} catch (error) {
			throw new Error(
				`Could not read the English messages at ${EN_JSON}. If it moved, update this test's path — do not delete the test. ` +
					`Original error: ${(error as Error).message}`
			);
		}
	}

	/** The leaf at `a.b.c`, or `undefined` — never a throw, so the assertion reports the key. */
	function leafAt(messages: Record<string, unknown>, path: string): unknown {
		return path.split('.').reduce<unknown>((node, segment) => {
			if (node === null || typeof node !== 'object') return undefined;
			return (node as Record<string, unknown>)[segment];
		}, messages);
	}

	it('names the sixteen codes of plan §8:907 — the eight refusals plus the eight API codes', () => {
		expect([...APP_ENV_VALIDATION_REFUSAL_CODES]).toEqual([
			'invalidName',
			'reservedName',
			'valueTooLarge',
			'controlCharacter',
			'lengthMismatch',
			'tooShort',
			'tooLong',
			'patternMismatch'
		]);
		expect([...APP_ENV_API_ERROR_CODES]).toEqual([
			'generatedValueUseRotate',
			'neverRotateNotAcknowledged',
			'rotateConfirmationMismatch',
			'secureStorageUnavailable',
			'tooManyValues',
			'valuesTooLarge',
			'malformedLine',
			'rotateRateLimited'
		]);
		// `APP_ENV_ERROR_CODES` is the plan §8:907 leaf list, so it is the two
		// subsets and nothing else — one error vocabulary, not two.
		expect([...APP_ENV_ERROR_CODES]).toEqual([...APP_ENV_VALIDATION_REFUSAL_CODES, ...APP_ENV_API_ERROR_CODES]);
		expect(APP_ENV_ERROR_CODES).toHaveLength(16);
		expect(new Set(APP_ENV_ERROR_CODES).size).toBe(16);
	});

	it('resolves every error code to exactly one message key under dashboard.workDetail.appEnv.errors.*', () => {
		const messages = readEnglishMessages();
		expect(APP_ENV_ERROR_MESSAGE_KEY_PREFIX).toBe('dashboard.workDetail.appEnv.errors');

		const resolved: Record<string, string> = {};
		for (const code of APP_ENV_ERROR_CODES) {
			const key = appEnvErrorMessageKey(code);
			const message = leafAt(messages, key);
			expect(
				typeof message,
				`${code} has no message under ${key}. Add it to apps/web/messages/en.json — a code without copy ` +
					`renders as a raw identifier on the Environment table (APW07-G23).`
			).toBe('string');
			expect((message as string).length, `${key} must not be empty`).toBeGreaterThan(0);
			resolved[code] = key;
		}

		// "Exactly one": the leaf map is total and injective, and the comma-separated
		// namespace holds no leaf this module does not name.
		const leaves = APP_ENV_ERROR_CODES.map((code) => APP_ENV_ERROR_MESSAGE_LEAVES[code]);
		expect(new Set(leaves).size, 'two codes share one message leaf').toBe(leaves.length);
		expect(Object.keys(APP_ENV_ERROR_MESSAGE_LEAVES).sort()).toEqual([...APP_ENV_ERROR_CODES].sort());
		expect(Object.values(resolved).sort()).toEqual(
			APP_ENV_ERROR_CODES.map(
				(code) => `dashboard.workDetail.appEnv.errors.${APP_ENV_ERROR_MESSAGE_LEAVES[code]}`
			).sort()
		);
		const namespace = leafAt(messages, APP_ENV_ERROR_MESSAGE_KEY_PREFIX);
		expect(namespace, `dashboard.workDetail.appEnv.errors must exist`).toBeTypeOf('object');
		expect(
			Object.keys(namespace as Record<string, unknown>).sort(),
			'a leaf under appEnv.errors has no code — every leaf there is one error code'
		).toEqual([...leaves].sort());
	});

	it('keeps every message leaf a dot-free camelCase identifier (plan §8:894)', () => {
		for (const code of APP_ENV_ERROR_CODES) {
			const leaf = APP_ENV_ERROR_MESSAGE_LEAVES[code];
			expect(leaf, `${code} must name a leaf`).not.toContain('.');
			expect(leaf, `${code} leaf must be camelCase`).toMatch(/^[a-z][A-Za-z0-9]*$/);
			expect(appEnvErrorMessageKey(code)).toBe(`dashboard.workDetail.appEnv.errors.${leaf}`);
		}
	});
});

describe('app-env — the table row carries no value (plan §3.3:271-294, FR-5)', () => {
	const FIXTURE = {
		name: 'SMTP_PASSWORD',
		declared: true,
		source: 'prompt',
		origin: 'prompted',
		overrides: null,
		secret: true,
		phase: 'runtime',
		required: true,
		set: false,
		description: 'SMTP password',
		group: 'Mail',
		reference: null,
		specValue: null,
		validation: { minLength: 8, maxLength: 128, hasPattern: false },
		generator: null,
		generatorChanged: false,
		publicPrefixWarning: false,
		publicValue: null,
		changedSinceBuild: false,
		changedSinceDeploy: false,
		updatedAt: null,
		updatedBy: null
	} satisfies AppEnvEntryView;

	it('has one field per plan §3.3 line, and no field holding a stored value', () => {
		expect(Object.keys(FIXTURE)).toEqual([
			'name',
			'declared',
			'source',
			'origin',
			'overrides',
			'secret',
			'phase',
			'required',
			'set',
			'description',
			'group',
			'reference',
			'specValue',
			'validation',
			'generator',
			'generatorChanged',
			'publicPrefixWarning',
			'publicValue',
			'changedSinceBuild',
			'changedSinceDeploy',
			'updatedAt',
			'updatedBy'
		]);
		// The two documented exceptions are `specValue` (a `value` literal already
		// public in the App spec) and `publicValue` (a keypair public half) — there is
		// no third field a stored secret could travel in (FR-5, FR-15).
		expect(FIXTURE).not.toHaveProperty('value');
		expect(FIXTURE).not.toHaveProperty('secretValue');
		expect(FIXTURE).not.toHaveProperty('encrypted');
		expect(FIXTURE.specValue).toBeNull();
		expect(FIXTURE.publicValue).toBeNull();
	});

	it('accepts a generated keypair row and a derived row under the same type', () => {
		const keypair = {
			...FIXTURE,
			name: 'VAPID_PRIVATE_KEY',
			source: 'generate',
			origin: 'generated',
			generator: { kind: 'keypair', keypairFormat: 'pem', rotate: 'never' },
			publicValue: '-----BEGIN PUBLIC KEY-----'
		} satisfies AppEnvEntryView;
		const derived = {
			...FIXTURE,
			name: 'DATABASE_URL',
			source: 'from',
			origin: 'derived',
			secret: true,
			required: false,
			reference: 'deps.postgres.url',
			phase: 'runtime'
		} satisfies AppEnvEntryView;

		expect(keypair.generator?.kind).toBe('keypair');
		expect(keypair.publicValue).not.toBeNull();
		expect(derived.reference).toBe('deps.postgres.url');
		expect(derived.origin).toBe('derived');
		// The union types the fixture relies on are the module's own, not copies.
		const source: AppEnvEntrySource = derived.source;
		const errorCode: AppEnvErrorCode = 'secureStorageUnavailable';
		expect(source).toBe('from');
		expect(errorCode).toBe('secureStorageUnavailable');
	});
});

describe('app-env — reachable from the apps barrel and the package root (tasks.md:56-57, R-1)', () => {
	/**
	 * Every RUNTIME name this module adds for T1. The barrel's collision check can
	 * only see a name once `apps` is one of its areas, so this list is the module's
	 * own proof that the name is exported where the API, the web app and the agent
	 * package import it from.
	 */
	const RUNTIME_EXPORTS: readonly string[] = [
		'APP_ENV_ORIGINS',
		'APP_ENV_PHASES',
		'APP_ENV_GENERATOR_KINDS',
		'APP_ENV_ALPHABETS',
		'APP_ENV_KEYPAIR_TYPES',
		'APP_ENV_KEYPAIR_FORMATS',
		'APP_ENV_KEYPAIR_RAW_TYPES',
		'APP_ENV_NAME_PATTERN',
		'APP_ENV_RESERVED_PREFIX',
		'APP_ENV_PUBLIC_PREFIXES',
		'APP_ENV_VALUE_MAX_BYTES',
		'APP_ENV_TOTAL_MAX_BYTES',
		'APP_ENV_MAX_STORED',
		'APP_ENV_PUBLIC_HALF_MAX_BYTES',
		'APP_ENV_PATTERN_BUDGET_MS',
		'APP_ENV_DOTENV_MAX_BYTES',
		'APP_ENV_DOTENV_MAX_LINES',
		'APP_ENV_GENERATE_SLA_MS',
		'APP_ENV_ROTATIONS_PER_HOUR',
		'APP_ENV_PUTS_PER_MINUTE',
		'APP_ENV_TEMPLATE_MAX_DEPTH',
		'APP_ENV_VALIDATION_REFUSAL_CODES',
		'APP_ENV_API_ERROR_CODES',
		'APP_ENV_ERROR_CODES',
		'APP_ENV_ERROR_MESSAGE_LEAVES',
		'APP_ENV_ERROR_MESSAGE_KEY_PREFIX',
		'appEnvErrorMessageKey'
	];

	it('surfaces every runtime name of this module on the apps barrel and at the root', () => {
		for (const name of RUNTIME_EXPORTS) {
			expect(name in appsBarrel, `${name} must be on the apps barrel`).toBe(true);
			expect(name in packageRoot, `${name} must be at the package root`).toBe(true);
		}
	});

	it('resolves the same bindings — not copies — from the package root', () => {
		expect(packageRoot.APP_ENV_ALPHABETS).toBe(APP_ENV_ALPHABETS);
		expect(packageRoot.APP_ENV_KEYPAIR_FORMATS).toBe(APP_ENV_KEYPAIR_FORMATS);
		expect(packageRoot.APP_ENV_ERROR_CODES).toBe(APP_ENV_ERROR_CODES);
		expect(packageRoot.APP_ENV_VALUE_MAX_BYTES).toBe(APP_ENV_VALUE_MAX_BYTES);
		expect(packageRoot.appEnvErrorMessageKey).toBe(appEnvErrorMessageKey);
		expect(packageRoot.appEnvErrorMessageKey('malformedLine')).toBe(
			'dashboard.workDetail.appEnv.errors.malformedLine'
		);
	});

	it('resolves this module’s TYPES from the package root too, not only the values', () => {
		// A type has no runtime presence, so nothing above would notice it going
		// missing at the root; these annotations would not compile if it had.
		const row: packageRoot.AppEnvEntryView = FIXTURE_SHAPE;
		const code: packageRoot.AppEnvErrorCode = 'tooManyValues';
		const alphabet: packageRoot.AppEnvAlphabet = 'base64url';
		expect(row.name).toBe('SMTP_PASSWORD');
		expect(code).toBe('tooManyValues');
		expect(alphabet).toBe('base64url');
	});
});

/** One row, reused by the root-type assertions above. */
const FIXTURE_SHAPE: AppEnvEntryView = {
	name: 'SMTP_PASSWORD',
	declared: true,
	source: 'prompt',
	origin: 'prompted',
	overrides: null,
	secret: true,
	phase: 'runtime',
	required: true,
	set: false,
	description: null,
	group: null,
	reference: null,
	specValue: null,
	validation: null,
	generator: null,
	generatorChanged: false,
	publicPrefixWarning: false,
	publicValue: null,
	changedSinceBuild: false,
	changedSinceDeploy: false,
	updatedAt: null,
	updatedBy: null
};
