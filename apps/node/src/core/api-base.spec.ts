import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_URL_ENV, KNOWN_STABLE_API_BASES, describeApiBase, readApiUrlPin, resolveApiBase } from './api-base';
import { FleetClientError } from './fleet-client';

const ENROLLED = 'https://api.ever.works';
const config = { apiUrl: ENROLLED };

describe('resolveApiBase — the operator pin for the control plane', () => {
	it('uses the enrolled origin when nothing is pinned', () => {
		const base = resolveApiBase(config, {});
		expect(base).toEqual({
			url: ENROLLED,
			source: 'config',
			configuredUrl: ENROLLED,
			pinnedTo: null,
			mismatch: false
		});
	});

	it('a pin wins over the enrolled origin', () => {
		const base = resolveApiBase(config, { [API_URL_ENV]: 'https://apistage.ever.works' });
		expect(base.url).toBe('https://apistage.ever.works');
		expect(base.source).toBe('pin');
		// The enrolled origin is still reported: it is what the secret was
		// minted against, and losing sight of it is how a mismatch becomes a
		// mystery.
		expect(base.configuredUrl).toBe(ENROLLED);
		expect(base.mismatch).toBe(true);
	});

	it('canonicalizes a pin exactly like the enrolled value (trailing slashes, case)', () => {
		const base = resolveApiBase(config, { [API_URL_ENV]: 'https://APIStage.Ever.Works/////' });
		expect(base.url).toBe('https://apistage.ever.works');
		expect(base.pinnedTo).toBe('https://apistage.ever.works');
	});

	it('a pin equal to the enrolled origin is reported as a pin, but not a mismatch', () => {
		// Both facts matter: the operator DID set it (so unsetting it changes
		// nothing today, and they should know that), and it is harmless.
		const base = resolveApiBase(config, { [API_URL_ENV]: `${ENROLLED}/` });
		expect(base.source).toBe('pin');
		expect(base.mismatch).toBe(false);
		expect(describeApiBase(base)).toContain('matches the enrolled origin');
	});

	it.each(['', '   ', '\t\n'])('treats an empty pin (%j) as absent, never as "no API"', (value) => {
		// `EVER_WORKS_NODE_API_URL=` in a unit file is how an operator turns an
		// override OFF. It must not brick the node.
		const base = resolveApiBase(config, { [API_URL_ENV]: value });
		expect(base.source).toBe('config');
		expect(base.url).toBe(ENROLLED);
		expect(base.pinnedTo).toBeNull();
	});

	it.each(['not a url', 'ftp://api.ever.works', '/api/fleet', 'api.ever.works'])(
		'refuses a malformed pin (%s) at startup rather than at the first request',
		(value) => {
			// A typo here would otherwise surface as a 403/404 the node reports
			// as `invalid-request` — indistinguishable from a platform fault.
			let thrown: unknown;
			try {
				resolveApiBase(config, { [API_URL_ENV]: value });
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(FleetClientError);
			expect((thrown as FleetClientError).kind).toBe('invalid-request');
		}
	);

	it('never mutates the config it was handed', () => {
		const source = { apiUrl: ENROLLED };
		resolveApiBase(source, { [API_URL_ENV]: 'https://apistage.ever.works' });
		// The pin must be reversible by unsetting the variable, which it cannot
		// be if anything writes it back into the config that gets saved.
		expect(source).toEqual({ apiUrl: ENROLLED });
	});
});

describe('readApiUrlPin — the pin without an enrollment', () => {
	it('returns null when unset, and the canonical origin when set', () => {
		expect(readApiUrlPin({})).toBeNull();
		expect(readApiUrlPin({ [API_URL_ENV]: 'https://apistage.ever.works/' })).toBe('https://apistage.ever.works');
	});
});

describe('describeApiBase — one wording for every surface', () => {
	it('says where an unpinned base came from', () => {
		expect(describeApiBase(resolveApiBase(config, {}))).toBe(`${ENROLLED} (from the enrolled config)`);
	});

	it('warns explicitly that a mismatched pin will 401 every call', () => {
		const text = describeApiBase(resolveApiBase(config, { [API_URL_ENV]: 'https://apistage.ever.works' }));
		expect(text).toContain('PINNED');
		expect(text).toContain(ENROLLED);
		expect(text).toContain('401');
	});
});

describe('KNOWN_STABLE_API_BASES — the origins the runbook tells an operator to pin to', () => {
	const repositoryRoot = join(__dirname, '../../../..');
	const read = (relative: string): string => readFileSync(join(repositoryRoot, relative), 'utf8');

	it('is the pair the constant claims it is', () => {
		// A literal, not a re-derivation: this is the value the docs below are
		// checked against, so it has to be pinned somewhere the compiler cannot
		// reconcile with the constant's own definition.
		expect([...KNOWN_STABLE_API_BASES]).toEqual(['https://apistage.ever.works', 'https://api.ever.works']);
	});

	it.each(['docs/runbooks/FLEET_BREAK_GLASS.md', 'docs/features/fleet.md', 'apps/node/README.md'])(
		'%s names every one of them',
		(relative) => {
			// The constant's docblock says it exists so the runbook and the operator
			// docs cannot drift from each other. Nothing made that true until this
			// case: an exported constant nobody reads is a comment, not a guarantee.
			// A break-glass procedure that names an origin the code does not, or
			// omits one it does, is a procedure that fails at 2am.
			const text = read(relative);
			for (const base of KNOWN_STABLE_API_BASES) {
				expect(text).toContain(base);
			}
		}
	);

	it('every pinned origin is one this resolver would accept', () => {
		// A published origin that the node's own URL canonicalization would
		// reject or rewrite is a runbook step that cannot be followed.
		for (const base of KNOWN_STABLE_API_BASES) {
			expect(resolveApiBase({ apiUrl: base }, { [API_URL_ENV]: base }).url).toBe(base);
		}
	});
});
