import { describe, expect, it } from 'vitest';

import {
	ACTION_PINS,
	ACTION_PIN_SHA_PATTERN,
	actionPin,
	actionPinReference,
	canonicalActionPins,
	type ActionPinKey
} from '../workflow/action-pins.js';
import { generateWorkflow } from '../workflow/generator.js';
import { goldenFixtures } from './fixtures/workflow-fixtures.js';

/**
 * APW-05 T8 — every third-party action the generated workflow runs is pinned to a
 * commit (plan §4.5, ACC-05-05).
 *
 * A pin is a 40-character commit hash with its release tag in a trailing comment,
 * resolved from the tag with `git ls-remote --tags`, peeling annotated tags so a
 * tag object's hash can never be mistaken for a commit (the module's docstring
 * records the command and the day). The last case here is the one that keeps the
 * pin set honest: it walks a **generated file** and requires every `uses:` to be
 * one of the five.
 */

const PIN_KEYS = ['checkout', 'setupBuildx', 'login', 'buildPush', 'uploadArtifact'] as const;

describe('action pins — the five actions of plan §4.3 (ACC-05-05)', () => {
	it('pins exactly the five actions the generator may use, in declaration order', () => {
		expect(Object.keys(ACTION_PINS)).toEqual([...PIN_KEYS]);
	});

	it('gives every pin a 40-character commit hash', () => {
		for (const key of PIN_KEYS) {
			const pin = ACTION_PINS[key];
			expect(pin.sha, key).toMatch(ACTION_PIN_SHA_PATTERN);
			expect(pin.sha, key).toHaveLength(40);
			expect(pin.sha, key).toBe(pin.sha.toLowerCase());
		}
	});

	it('names a real action and a release tag beside every hash', () => {
		for (const key of PIN_KEYS) {
			const pin = ACTION_PINS[key];
			expect(pin.action, key).toMatch(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
			expect(pin.action, key).not.toContain('@');
			expect(pin.tag, key).toMatch(/^v\d+\.\d+\.\d+/);
			expect(pin.resolvedOn, key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});

	it('resolves each hash from a tag of the action it names', () => {
		// The five SHAs were read from these repositories, in this order — a copy-paste
		// between two rows is the one mistake a hash cannot reveal on its own.
		expect(Object.values(ACTION_PINS).map((pin) => pin.action)).toEqual([
			'actions/checkout',
			'docker/setup-buildx-action',
			'docker/login-action',
			'docker/build-push-action',
			'actions/upload-artifact'
		]);
		expect(new Set(Object.values(ACTION_PINS).map((pin) => pin.sha)).size).toBe(PIN_KEYS.length);
	});

	it('renders a pin as `owner/repo@<sha> # <tag>` and without the comment for a canonical input', () => {
		expect(actionPin(ACTION_PINS.checkout)).toBe(
			'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1'
		);
		expect(actionPinReference(ACTION_PINS.checkout)).toBe(
			'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
		);
	});

	it('canonicalises the set with sorted keys, so a bump moves the fingerprint', () => {
		const canonical = canonicalActionPins();
		expect(Object.keys(canonical)).toEqual([...PIN_KEYS].sort());
		for (const key of PIN_KEYS) {
			expect(canonical[key as ActionPinKey]).toBe(actionPinReference(ACTION_PINS[key]));
		}
	});
});

describe('action pins — the generated file uses nothing else (ACC-05-05)', () => {
	it('resolves every `uses:` of every fixture to one of the five pins', () => {
		const references = Object.values(goldenFixtures()).flatMap((fixture) =>
			[...generateWorkflow(fixture).matchAll(/uses:\s+(\S+)/g)].map((match) => match[1])
		);
		expect(references.length).toBeGreaterThan(0);
		const allowed = new Set(Object.values(ACTION_PINS).map(actionPinReference));
		expect(references.filter((reference) => !allowed.has(reference))).toEqual([]);
	});
});
