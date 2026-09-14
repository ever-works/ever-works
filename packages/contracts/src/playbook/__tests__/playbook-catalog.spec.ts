import { describe, expect, it } from 'vitest';
import {
	acceptPlaybookEntry,
	catalogSearchRank,
	comparePlaybookVersions,
	playbookSearchFields,
	PLAYBOOK_TEXT_LIMITS,
	sanitizePlaybookEntry,
	sanitizePlaybookText,
	validatePlaybookEntry,
	type PlaybookCatalogEntry
} from '../playbook-catalog.types.js';

function entry(overrides: Record<string, unknown> = {}): PlaybookCatalogEntry {
	return {
		slug: 'weekly-operations-report',
		title: 'Weekly operations report',
		outcome: 'One document every Monday: shipped, stuck, needs you.',
		summary: 'Reads the week and writes one short report.',
		category: 'reporting',
		version: '1.0.0',
		icon: 'report',
		trigger: { kind: 'schedule', cadence: '0 7 * * 1', defaultLocalTime: '07:00', description: 'Mondays 07:00' },
		steps: [
			{ position: 1, title: 'Read the week', produces: 'A list of what changed.', requiresApproval: false },
			{ position: 2, title: 'Write the report', produces: 'One document.', requiresApproval: false }
		],
		connections: [],
		artefacts: [{ kind: 'kb_document', title: 'Weekly report', where: 'Reports' }],
		escalations: [{ when: 'An open decision exists', becomes: 'approval', carriesRecommendation: true }],
		caps: { maxWordCount: 600 },
		costBand: 'low',
		estimatedTokensPerRun: { min: 8000, max: 20000 },
		tags: ['weekly'],
		provision: {
			agentTemplateSlug: 'content-marketer',
			agentName: 'Ops reporter',
			skillSlugs: ['digest-compilation'],
			taskTemplate: { name: 'Weekly operations report', slug: 'weekly-operations-report' },
			guardrailsAtAdoption: { mode: 'require_approval' }
		},
		...overrides
	} as PlaybookCatalogEntry;
}

describe('validatePlaybookEntry', () => {
	it('accepts a well-formed entry', () => {
		expect(validatePlaybookEntry(entry())).toBeNull();
	});

	it.each<[string, unknown]>([
		['not an object', 'nope'],
		['an array', []],
		['null', null]
	])('rejects %s', (_label, value) => {
		expect(validatePlaybookEntry(value)).toBe('entry must be an object');
	});

	it.each<[string, Record<string, unknown>, RegExp]>([
		['an uppercase slug', { slug: 'Weekly' }, /^slug/],
		['a slug starting with a dash', { slug: '-weekly' }, /^slug/],
		['a 65-character slug', { slug: 'a'.repeat(65) }, /^slug/],
		['an empty title', { title: '  ' }, /^title/],
		['a 121-character title', { title: 'x'.repeat(121) }, /^title/],
		['a 201-character outcome', { outcome: 'x'.repeat(201) }, /^outcome/],
		['a 601-character summary', { summary: 'x'.repeat(601) }, /^summary/],
		['an unknown category', { category: 'sales' }, /^category/],
		['a two-part version', { version: '1.0' }, /^version/],
		['a non-numeric version', { version: '1.0.x' }, /^version/],
		['a missing icon', { icon: 7 }, /^icon/],
		['an unknown cost band', { costBand: 'free' }, /^costBand/],
		['an inverted token estimate', { estimatedTokensPerRun: { min: 10, max: 5 } }, /^estimatedTokensPerRun/],
		['a missing trigger', { trigger: null }, /^trigger must/],
		['an unknown trigger kind', { trigger: { kind: 'cron', description: 'x' } }, /^trigger\.kind/],
		['an empty trigger description', { trigger: { kind: 'manual', description: '' } }, /^trigger\.description/],
		['one step', { steps: [{ position: 1, title: 'a', produces: 'b', requiresApproval: false }] }, /^steps must/],
		[
			'nine steps',
			{
				steps: Array.from({ length: 9 }, (_, i) => ({
					position: i + 1,
					title: `s${i}`,
					produces: 'p',
					requiresApproval: false
				}))
			},
			/^steps must/
		],
		[
			'a non-object step',
			{ steps: ['a', { position: 2, title: 'b', produces: 'c', requiresApproval: false }] },
			/^steps\[0\] must/
		],
		[
			'a 121-character step title',
			{
				steps: [
					{ position: 1, title: 'x'.repeat(121), produces: 'p', requiresApproval: false },
					{ position: 2, title: 'b', produces: 'p', requiresApproval: false }
				]
			},
			/^steps\[0\]\.title/
		],
		[
			'a step without produces',
			{
				steps: [
					{ position: 1, title: 'a', produces: '', requiresApproval: false },
					{ position: 2, title: 'b', produces: 'p', requiresApproval: false }
				]
			},
			/^steps\[0\]\.produces/
		],
		[
			'a step without requiresApproval',
			{
				steps: [
					{ position: 1, title: 'a', produces: 'p' },
					{ position: 2, title: 'b', produces: 'p', requiresApproval: false }
				]
			},
			/^steps\[0\]\.requiresApproval/
		],
		['connections that are not a list', { connections: {} }, /^connections must/],
		['a non-object connection', { connections: [1] }, /^connections\[0\] must/],
		['a connection without a capability', { connections: [{ required: true, reason: 'r' }] }, /capability/],
		['a connection without required', { connections: [{ capability: 'search', reason: 'r' }] }, /required/],
		[
			'a 201-character reason',
			{ connections: [{ capability: 'search', required: true, reason: 'x'.repeat(201) }] },
			/reason/
		],
		['artefacts that are not a list', { artefacts: 'x' }, /^artefacts must/],
		['an unknown artefact kind', { artefacts: [{ kind: 'pdf', title: 't', where: 'w' }] }, /^artefacts\[0\]/],
		['escalations that are not a list', { escalations: 'x' }, /^escalations must/],
		['an unknown escalation target', { escalations: [{ when: 'w', becomes: 'email' }] }, /^escalations\[0\]/],
		['missing caps', { caps: null }, /^caps/],
		['non-string tags', { tags: [1] }, /^tags/]
	])('rejects %s', (_label, overrides, message) => {
		expect(validatePlaybookEntry(entry(overrides))).toMatch(message);
	});

	it.each<[string, Record<string, unknown>, RegExp]>([
		['a missing provision', { provision: null }, /^provision must/],
		['a missing agent template', { agentTemplateSlug: '' }, /agentTemplateSlug/],
		['a missing agent name', { agentName: '' }, /agentName/],
		['non-string skill slugs', { skillSlugs: [1] }, /skillSlugs/],
		['a missing task template name', { taskTemplate: { slug: 'x' } }, /taskTemplate/],
		['an unknown guardrail mode', { guardrailsAtAdoption: { mode: 'yolo' } }, /guardrailsAtAdoption\.mode/],
		[
			'non-string blocked action types',
			{ guardrailsAtAdoption: { mode: 'require_approval', blockedActionTypes: [3] } },
			/blockedActionTypes/
		],
		['a malformed graduated posture', { graduatedGuardrails: 'autonomous' }, /graduatedGuardrails/]
	])('rejects a provision with %s', (_label, overrides, message) => {
		const base = entry();
		const provision = overrides.provision === null ? null : { ...base.provision, ...overrides };
		expect(validatePlaybookEntry({ ...base, provision })).toMatch(message);
	});

	it('accepts exactly 2 and exactly 8 steps', () => {
		const steps = (n: number) =>
			Array.from({ length: n }, (_, i) => ({
				position: i + 1,
				title: `s${i}`,
				produces: 'p',
				requiresApproval: false
			}));
		expect(validatePlaybookEntry(entry({ steps: steps(2) }))).toBeNull();
		expect(validatePlaybookEntry(entry({ steps: steps(8) }))).toBeNull();
	});

	it('accepts a 64-character slug and a 120-character title', () => {
		expect(validatePlaybookEntry(entry({ slug: `a${'b'.repeat(63)}`, title: 'x'.repeat(120) }))).toBeNull();
	});
});

describe('comparePlaybookVersions', () => {
	it('compares numerically, not lexically', () => {
		expect(comparePlaybookVersions('1.10.0', '1.9.0')).toBe(1);
		expect(comparePlaybookVersions('1.9.0', '1.10.0')).toBe(-1);
		expect(comparePlaybookVersions('2.0.0', '1.99.99')).toBe(1);
		expect(comparePlaybookVersions('1.0.10', '1.0.9')).toBe(1);
	});

	it('treats equal versions as equal', () => {
		expect(comparePlaybookVersions('1.2.3', '1.2.3')).toBe(0);
	});

	it('sorts a malformed version below any well-formed one', () => {
		expect(comparePlaybookVersions('latest', '0.0.1')).toBe(-1);
		expect(comparePlaybookVersions('0.0.1', 'v1')).toBe(1);
		expect(comparePlaybookVersions('x', 'y')).toBe(0);
	});
});

describe('catalogSearchRank', () => {
	const fields = playbookSearchFields({
		title: 'Weekly operations report',
		tags: ['ops'],
		outcome: 'One document every Monday.',
		summary: 'Reads the week.',
		stepTitles: ['Collect open decisions']
	});

	it('ranks title above tags above summary above step titles', () => {
		expect(catalogSearchRank(fields, 'WEEKLY')).toBe(0);
		expect(catalogSearchRank(fields, 'ops')).toBe(1);
		expect(catalogSearchRank(fields, 'monday')).toBe(2);
		expect(catalogSearchRank(fields, 'decisions')).toBe(3);
	});

	it('returns null when nothing matches', () => {
		expect(catalogSearchRank(fields, 'zzz')).toBeNull();
	});

	it('matches everything below the 2-character minimum', () => {
		expect(catalogSearchRank(fields, 'z')).toBe(0);
		expect(catalogSearchRank(fields, '  ')).toBe(0);
		expect(catalogSearchRank({ title: 'x' }, 'zz')).toBeNull();
	});
});

describe('acceptPlaybookEntry', () => {
	it('truncates an over-long title instead of rejecting the entry', () => {
		const result = acceptPlaybookEntry(entry({ title: `<b>${'t'.repeat(300)}</b>` }));
		expect(result.violation).toBeNull();
		expect(result.entry?.title).toHaveLength(120);
	});

	it('drops an entry with an invalid slug', () => {
		expect(acceptPlaybookEntry(entry({ slug: 'Not A Slug' }))).toEqual({
			entry: null,
			violation: expect.stringMatching(/^slug/)
		});
	});

	it('drops a title that is only markup', () => {
		expect(acceptPlaybookEntry(entry({ title: '<b></b>' })).violation).toMatch(/^title/);
	});

	it('never throws on structurally broken input', () => {
		expect(acceptPlaybookEntry('garbage').violation).toBe('entry must be an object');
		expect(acceptPlaybookEntry({ slug: 'ok' }).violation).toMatch(/^title/);
		expect(acceptPlaybookEntry(entry({ steps: 'nope' })).violation).toMatch(/^steps/);
		expect(acceptPlaybookEntry(entry({ title: 42 })).violation).toMatch(/^title/);
	});
});

describe('sanitizePlaybookText / sanitizePlaybookEntry', () => {
	it('strips markup and caps the length', () => {
		expect(sanitizePlaybookText('<b>Hello</b> <script>x</script>world', 200)).toBe('Hello xworld');
		expect(sanitizePlaybookText('x'.repeat(300), PLAYBOOK_TEXT_LIMITS.title)).toHaveLength(120);
	});

	it('caps an over-long title at 120 characters and strips HTML from nested strings', () => {
		const raw = entry({
			title: `<i>${'t'.repeat(150)}</i>`,
			connections: [
				{ capability: 'search', required: false, reason: '<a>why</a>', degradedWithout: '<b>less</b>' }
			]
		});
		const clean = sanitizePlaybookEntry(raw);
		expect(clean.title).toHaveLength(120);
		expect(clean.title).not.toContain('<');
		expect(clean.connections[0]).toEqual({
			capability: 'search',
			required: false,
			reason: 'why',
			degradedWithout: 'less'
		});
		expect(validatePlaybookEntry(clean)).toBeNull();
	});

	it('keeps an absent optional field absent', () => {
		const clean = sanitizePlaybookEntry(
			entry({
				connections: [{ capability: 'search', required: true, reason: 'r' }],
				trigger: { kind: 'manual', description: 'On demand' }
			})
		);
		expect(clean.connections[0]).not.toHaveProperty('degradedWithout');
		expect(clean.trigger).not.toHaveProperty('cadence');
	});
});
