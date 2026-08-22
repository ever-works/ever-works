import { describe, expect, it } from 'vitest';

import {
	KB_CITATION_CONSUMER_TYPES,
	KB_DECISION_STATUSES,
	KB_DOCUMENT_CLASSES,
	KB_DOCUMENT_SOURCES,
	KB_DOCUMENT_STATUSES,
	KB_LOCK_MODES,
	KB_ORG_INHERITABLE_CLASSES,
	KB_REVIEW_STATES,
	KB_UPLOAD_EXTRACTION_STATUSES
} from '../kb-document-class.js';

/**
 * `kb-document-class.ts` is the WIRE-FORMAT MIRROR of the agent-side KB
 * enums (`@ever-works/agent/entities/kb-types.ts`). The contracts package
 * has zero dependencies and deliberately cannot import the agent, so
 * nothing at build time proves the two lists still agree — these
 * assertions are the mirror's only guard rail.
 *
 * Every literal is pinned BY NAME because each one is persisted verbatim
 * in a Postgres column and shipped over the wire to Web / CLI / MCP:
 * renaming a member is a data migration, not a refactor.
 */

/** Anchored token shape every KB vocabulary member follows. */
const KEBAB_TOKEN = /^[a-z]+(-[a-z]+)*$/;

/** [exported name, members] — drives the matrix-style hygiene checks. */
const VOCABULARIES: Array<[string, readonly string[]]> = [
	['KB_DOCUMENT_CLASSES', KB_DOCUMENT_CLASSES],
	['KB_DECISION_STATUSES', KB_DECISION_STATUSES],
	['KB_REVIEW_STATES', KB_REVIEW_STATES],
	['KB_ORG_INHERITABLE_CLASSES', KB_ORG_INHERITABLE_CLASSES],
	['KB_DOCUMENT_STATUSES', KB_DOCUMENT_STATUSES],
	['KB_LOCK_MODES', KB_LOCK_MODES],
	['KB_DOCUMENT_SOURCES', KB_DOCUMENT_SOURCES],
	['KB_UPLOAD_EXTRACTION_STATUSES', KB_UPLOAD_EXTRACTION_STATUSES],
	['KB_CITATION_CONSUMER_TYPES', KB_CITATION_CONSUMER_TYPES]
];

describe('KB_DOCUMENT_CLASSES', () => {
	it('pins the eleven document classes, in the agent enum order', () => {
		expect(KB_DOCUMENT_CLASSES).toEqual([
			'brand',
			'legal',
			'seo',
			'style',
			'glossary',
			'competitors',
			'personas',
			'research',
			'output',
			'freeform',
			'decision'
		]);
		// Count is asserted separately from the literal so a silent
		// addition names itself in the failure output.
		expect(KB_DOCUMENT_CLASSES).toHaveLength(11);
	});

	it('opens with `brand` and closes with `decision` — new classes are appended, never inserted', () => {
		// The file header makes the agent-side enum the source of truth and
		// this array its mirror; keeping the member ORDER identical is what
		// lets a reviewer diff the two lists by eye. `decision` (memory
		// upgrades M4) was the most recent addition and sits last.
		expect(KB_DOCUMENT_CLASSES[0]).toBe('brand');
		expect(KB_DOCUMENT_CLASSES[KB_DOCUMENT_CLASSES.length - 1]).toBe('decision');
	});

	it('does not absorb the memory-facet vocabulary', () => {
		// `synthesized` / `human` / `connector` are BADGES derived at render
		// time (kb-memory-facets.ts) and `memory` is a path prefix, not a
		// class. Folding any of them in here would make the column
		// unwritable by the agent enum it mirrors.
		expect(KB_DOCUMENT_CLASSES).not.toContain('memory');
		expect(KB_DOCUMENT_CLASSES).not.toContain('synthesis');
		expect(KB_DOCUMENT_CLASSES).not.toContain('synthesized');
		expect(KB_DOCUMENT_CLASSES).not.toContain('decisions');
		expect(KB_DOCUMENT_CLASSES).not.toContain('brand-voice');
	});
});

describe('KB_DECISION_STATUSES', () => {
	it('pins the four decision statuses', () => {
		expect(KB_DECISION_STATUSES).toEqual(['proposed', 'accepted', 'superseded', 'archived']);
		expect(KB_DECISION_STATUSES).toHaveLength(4);
	});

	it('is ordered as the documented lifecycle proposed -> accepted -> superseded -> archived', () => {
		// The array's index order IS the state machine documented in the
		// file header and enforced agent-side by
		// KB_DECISION_STATUS_TRANSITIONS. A reversed decision is demoted to
		// `superseded`, never resurrected, so a "tidy up / alphabetise"
		// reorder here would misdescribe the machine to every UI that
		// renders the list as a progression.
		expect(KB_DECISION_STATUSES.indexOf('proposed')).toBeLessThan(KB_DECISION_STATUSES.indexOf('accepted'));
		expect(KB_DECISION_STATUSES.indexOf('accepted')).toBeLessThan(KB_DECISION_STATUSES.indexOf('superseded'));
		expect(KB_DECISION_STATUSES.indexOf('superseded')).toBeLessThan(KB_DECISION_STATUSES.indexOf('archived'));
	});

	it('ends on the terminal state `archived`', () => {
		// `archived -> []` agent-side: nothing transitions out of it.
		expect(KB_DECISION_STATUSES[0]).toBe('proposed');
		expect(KB_DECISION_STATUSES[KB_DECISION_STATUSES.length - 1]).toBe('archived');
	});
});

describe('KB_REVIEW_STATES', () => {
	it('pins the two review states', () => {
		expect(KB_REVIEW_STATES).toEqual(['proposed', 'accepted']);
		expect(KB_REVIEW_STATES).toHaveLength(2);
	});

	it('starts at `proposed` — the state agent-authored documents land in', () => {
		// Ordering is load-bearing in one direction only: `proposed`
		// documents are EXCLUDED from context injection until a human
		// accepts them, so `proposed` is the entry state and `accepted` the
		// exit state, not the other way round.
		expect(KB_REVIEW_STATES[0]).toBe('proposed');
		expect(KB_REVIEW_STATES[1]).toBe('accepted');
	});
});

describe('KB_ORG_INHERITABLE_CLASSES', () => {
	it('pins the v1 inheritable set: legal + style + seo', () => {
		expect(KB_ORG_INHERITABLE_CLASSES).toEqual(['legal', 'style', 'seo']);
		expect(KB_ORG_INHERITABLE_CLASSES).toHaveLength(3);
	});

	it.each([...KB_ORG_INHERITABLE_CLASSES])('%s is also a real document class', (inheritable) => {
		// THE headline invariant of this file. `as const satisfies
		// ReadonlyArray<KbDocumentClass>` is checked by tsc inside this one
		// module and then erased; nothing in a consumer's compiled output
		// re-checks it. This runtime assertion is what actually catches a
		// drift after someone edits either literal.
		expect(KB_DOCUMENT_CLASSES).toContain(inheritable);
	});

	it('is a strict subset — org inheritance is opt-in per class, not all-classes', () => {
		expect(KB_ORG_INHERITABLE_CLASSES.length).toBeLessThan(KB_DOCUMENT_CLASSES.length);
	});

	it('keeps brand identity, decisions and freeform notes per-Work', () => {
		// The file header's v1 rule is explicit: "Brand identity stays
		// per-Work always". Decisions and freeform notes are Work-scoped
		// history, so inheriting them would leak one Work's record into
		// every sibling Work in the org.
		expect(KB_ORG_INHERITABLE_CLASSES).not.toContain('brand');
		expect(KB_ORG_INHERITABLE_CLASSES).not.toContain('decision');
		expect(KB_ORG_INHERITABLE_CLASSES).not.toContain('freeform');
	});

	it('deliberately orders style before seo, unlike KB_DOCUMENT_CLASSES', () => {
		// The same three classes appear in the OPPOSITE relative order in
		// KB_DOCUMENT_CLASSES (seo at index 2, style at index 3). Both
		// orders match the agent side. Pinning the pair together means a
		// well-meaning "keep these in sync" refactor that reorders either
		// array breaks loudly instead of silently reshuffling the org
		// settings UI.
		expect(KB_ORG_INHERITABLE_CLASSES.indexOf('style')).toBeLessThan(KB_ORG_INHERITABLE_CLASSES.indexOf('seo'));
		expect(KB_DOCUMENT_CLASSES.indexOf('seo')).toBeLessThan(KB_DOCUMENT_CLASSES.indexOf('style'));
	});
});

describe('KB_DOCUMENT_STATUSES', () => {
	it('pins the three document statuses', () => {
		expect(KB_DOCUMENT_STATUSES).toEqual(['draft', 'active', 'archived']);
		expect(KB_DOCUMENT_STATUSES).toHaveLength(3);
	});

	it('is ordered draft -> active -> archived', () => {
		expect(KB_DOCUMENT_STATUSES[0]).toBe('draft');
		expect(KB_DOCUMENT_STATUSES[KB_DOCUMENT_STATUSES.length - 1]).toBe('archived');
	});

	it('has no `deleted` member — KB documents are archived, never hard-removed', () => {
		expect(KB_DOCUMENT_STATUSES).not.toContain('deleted');
		expect(KB_DOCUMENT_STATUSES).not.toContain('removed');
	});
});

describe('KB_LOCK_MODES', () => {
	it('pins the two lock modes', () => {
		expect(KB_LOCK_MODES).toEqual(['full', 'additions-only']);
		expect(KB_LOCK_MODES).toHaveLength(2);
	});

	it('lists the strictest mode first and models "unlocked" as null, not a member', () => {
		// `full` denies every write; `additions-only` is the relaxation.
		// There is deliberately no third member: unlocked is `null` on the
		// document (see the file's doc comment), so a future 'none' /
		// 'unlocked' literal here would be a modelling change, not an
		// addition.
		expect(KB_LOCK_MODES[0]).toBe('full');
		expect(KB_LOCK_MODES).not.toContain('none');
		expect(KB_LOCK_MODES).not.toContain('unlocked');
	});
});

describe('KB_DOCUMENT_SOURCES', () => {
	it('pins the four source attributions', () => {
		expect(KB_DOCUMENT_SOURCES).toEqual(['user', 'agent', 'imported', 'seeded']);
		expect(KB_DOCUMENT_SOURCES).toHaveLength(4);
	});

	it('has no `connector` member — connector provenance is metadata, not a source', () => {
		// Connector-derived memory is written with source `agent` /
		// `imported` and identified through `metadata.provenance.source`
		// (see deriveKbMemorySourceBadge). Adding a `connector` source here
		// would give the badge derivation two disagreeing inputs.
		expect(KB_DOCUMENT_SOURCES).not.toContain('connector');
		expect(KB_DOCUMENT_SOURCES).not.toContain('synthesized');
	});
});

describe('KB_UPLOAD_EXTRACTION_STATUSES', () => {
	it('pins the five extraction statuses', () => {
		expect(KB_UPLOAD_EXTRACTION_STATUSES).toEqual(['pending', 'running', 'succeeded', 'failed', 'skipped']);
		expect(KB_UPLOAD_EXTRACTION_STATUSES).toHaveLength(5);
	});

	it('lists the two in-flight states first and the three terminal outcomes last', () => {
		// queued -> working -> settled. A row only ever moves rightwards
		// across that boundary, so anything that reorders the head of this
		// array breaks the "is it still running?" reading of index < 2.
		expect(KB_UPLOAD_EXTRACTION_STATUSES[0]).toBe('pending');
		expect(KB_UPLOAD_EXTRACTION_STATUSES[1]).toBe('running');
		expect(KB_UPLOAD_EXTRACTION_STATUSES.slice(2)).toEqual(['succeeded', 'failed', 'skipped']);
	});

	it('keeps `skipped` distinct from `failed` — a skipped extraction is not an error', () => {
		expect(KB_UPLOAD_EXTRACTION_STATUSES).toContain('skipped');
		expect(KB_UPLOAD_EXTRACTION_STATUSES).toContain('failed');
		expect(KB_UPLOAD_EXTRACTION_STATUSES.indexOf('skipped')).not.toBe(
			KB_UPLOAD_EXTRACTION_STATUSES.indexOf('failed')
		);
	});
});

describe('KB_CITATION_CONSUMER_TYPES', () => {
	it('pins the five polymorphic citation consumers', () => {
		expect(KB_CITATION_CONSUMER_TYPES).toEqual([
			'agent-run',
			'generation-history',
			'conversation-message',
			'community-pr',
			'comparison'
		]);
		expect(KB_CITATION_CONSUMER_TYPES).toHaveLength(5);
	});

	it('names every consumer in the singular — the value discriminates one row', () => {
		// `consumerType` + `consumerId` is a polymorphic FK pair; a plural
		// literal here would read as a table name and invite a mismatch
		// with the id it is paired with.
		for (const consumer of KB_CITATION_CONSUMER_TYPES) {
			expect(consumer.endsWith('s')).toBe(false);
		}
	});
});

describe('shared vocabulary across the independent columns', () => {
	it('lets `archived` mean two different things in two different columns', () => {
		// KB_DECISION_STATUSES.archived (a decision's lifecycle) and
		// KB_DOCUMENT_STATUSES.archived (the document row's lifecycle) are
		// SEPARATE state machines that happen to share a word. Do not
		// "deduplicate" them: a decision can be `superseded` while its
		// document row is still `active`.
		expect(KB_DECISION_STATUSES).toContain('archived');
		expect(KB_DOCUMENT_STATUSES).toContain('archived');
		expect(KB_DECISION_STATUSES).not.toBe(KB_DOCUMENT_STATUSES);
	});

	it.each([...KB_REVIEW_STATES])('review state %s reuses a decision-status literal', (state) => {
		// KB_REVIEW_STATES is a value-level subset of KB_DECISION_STATUSES,
		// and that is intentional shared vocabulary, NOT the same column:
		// review state applies to a document of ANY class, decision status
		// only to `class === 'decision'`. Pinned so a future reader does not
		// collapse one into the other.
		expect(KB_DECISION_STATUSES).toContain(state);
	});

	it('keeps review states a strict subset — `superseded` is not a review outcome', () => {
		expect(KB_REVIEW_STATES.length).toBeLessThan(KB_DECISION_STATUSES.length);
		expect(KB_REVIEW_STATES).not.toContain('superseded');
		expect(KB_REVIEW_STATES).not.toContain('archived');
		// There is deliberately no `rejected` state: the review queue
		// accepts or leaves a document proposed, it never records a refusal.
		expect(KB_REVIEW_STATES).not.toContain('rejected');
	});
});

describe('vocabulary hygiene', () => {
	it.each(VOCABULARIES)('%s is a non-empty array of trimmed, non-blank strings', (_name, members) => {
		expect(Array.isArray(members)).toBe(true);
		expect(members.length).toBeGreaterThan(0);
		for (const member of members) {
			expect(typeof member).toBe('string');
			expect(member.length).toBeGreaterThan(0);
			// A stray space would survive `as const` and then be written to
			// the database verbatim.
			expect(member).toBe(member.trim());
		}
	});

	it.each(VOCABULARIES)('%s has no duplicate members', (_name, members) => {
		expect(new Set(members).size).toBe(members.length);
	});

	it.each(VOCABULARIES)('%s uses lowercase kebab-case tokens only', (_name, members) => {
		for (const member of members) {
			expect(member).toMatch(KEBAB_TOKEN);
		}
	});

	it.each(VOCABULARIES)('%s is NOT frozen at runtime', (_name, members) => {
		// `as const` is a purely compile-time assertion: at runtime these
		// are ordinary mutable arrays. This pins the CURRENT reality rather
		// than the desirable one — if someone adds Object.freeze, this test
		// fails and forces a deliberate review of every consumer that might
		// be sorting or splicing a shared array in place.
		expect(Object.isFrozen(members)).toBe(false);
	});

	it('exposes nine distinct array instances', () => {
		// Guards against a copy/paste that aliases two exports to the same
		// literal — `toEqual` alone would not notice.
		expect(VOCABULARIES).toHaveLength(9);
		expect(new Set(VOCABULARIES.map(([, members]) => members)).size).toBe(9);
	});
});

describe('the kebab-case token pattern is anchored', () => {
	it.each(['agent-run', 'additions-only', 'generation-history', 'conversation-message', 'brand', 'seo'])(
		'accepts %s',
		(value) => {
			expect(KEBAB_TOKEN.test(value)).toBe(true);
		}
	);

	it.each([
		['Agent-Run', 'uppercase'],
		['agent run', 'space instead of a hyphen'],
		['agent_run', 'underscore instead of a hyphen'],
		['agent--run', 'empty segment'],
		['agent-', 'trailing hyphen'],
		['-agent', 'leading hyphen'],
		[' agent-run', 'leading whitespace'],
		['agent-run ', 'trailing whitespace'],
		['agent-run2', 'digit'],
		['', 'empty string'],
		['use agent-run here', 'a valid token embedded in a longer string']
	])('rejects %s (%s)', (value) => {
		// The last case is the anchoring check: without ^ and $ the pattern
		// would happily match a substring of arbitrary text.
		expect(KEBAB_TOKEN.test(value)).toBe(false);
	});
});
