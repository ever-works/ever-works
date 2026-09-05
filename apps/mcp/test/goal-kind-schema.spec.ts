import { describe, it, expect } from 'vitest';
import { SchemaConverterService, type JsonSchema } from '../src/openapi-tools/schema-converter.service.js';

/**
 * `create_goal` tool schema — Goal kinds (self-build slice AG, EW-795).
 *
 * MCP tool input schemas are NOT hand-written: `SchemaConverterService`
 * derives them at runtime from the API's Swagger document, i.e. from the
 * `@ApiProperty` metadata on `CreateGoalDto`. This spec feeds the converter
 * the request-body schema Nest emits for the kind-aware DTO and pins what
 * an agent calling the tool can and cannot send:
 *
 *  - a classic metric payload still parses;
 *  - a delivery payload (`goalKind: 'delivery'` + `dodCriteria`, no metric
 *    keys at all) parses;
 *  - an unknown kind, a non-numeric target and an unknown DoD status are
 *    refused before the round trip;
 *  - the four metric names are NO LONGER in `required` — they are required
 *    for the metric kind only.
 *
 * The cross-field rule ("metric ⇒ all four, delivery ⇒ none of them + a
 * DoD") cannot be expressed in this schema: the converter turns `oneOf`
 * into `z.any()`, and JSON Schema `if/then` is not modelled at all. It is
 * enforced by the API (`CreateGoalDto` + `GoalsService.create`), which is
 * why the property descriptions carry it in prose.
 */
const DOD_CRITERION: JsonSchema = {
	type: 'object',
	properties: {
		id: { type: 'string', minLength: 1, maxLength: 64 },
		text: { type: 'string', minLength: 1, maxLength: 500 },
		status: { enum: ['open', 'done', 'waived'] },
		evidence: { type: 'string', nullable: true, maxLength: 1000 },
		note: { type: 'string', nullable: true, maxLength: 500 },
		source: { enum: ['operator', 'planner'] },
		updatedAt: { type: 'string' }
	},
	required: ['id', 'text', 'status']
};

/** What Nest emits for `CreateGoalDto` after the kind change (metric fields optional). */
const CREATE_GOAL_BODY: JsonSchema = {
	type: 'object',
	properties: {
		title: { type: 'string', minLength: 1, maxLength: 200 },
		description: { type: 'string', nullable: true, maxLength: 10000 },
		goalKind: {
			enum: ['metric', 'delivery'],
			default: 'metric',
			description:
				"'metric' (default) reads a metrics-provider plugin … 'delivery' has no metric: omit those fields, supply dodCriteria."
		},
		metricSource: {
			type: 'object',
			properties: {
				pluginId: { type: 'string', minLength: 1, maxLength: 100 },
				metricId: { type: 'string', minLength: 1, maxLength: 200 },
				params: { type: 'object' }
			},
			required: ['pluginId', 'metricId'],
			description: 'Metric Goals only — required when goalKind is metric, must be omitted for delivery.'
		},
		comparator: { enum: ['gte', 'lte'], description: 'Metric Goals only.' },
		targetValue: { type: 'number', description: 'Metric Goals only.' },
		unit: { type: 'string', minLength: 1, maxLength: 32, description: 'Metric Goals only.' },
		window: { enum: ['day', 'week', 'month', 'total', 'point'], description: 'Metric Goals only.' },
		baselineValue: { type: 'number', nullable: true },
		deadline: { type: 'string', nullable: true },
		checkFrequencyMinutes: { type: 'integer', minimum: 1, default: 60 },
		dodCriteria: {
			type: 'array',
			items: DOD_CRITERION,
			minItems: 1,
			maxItems: 50,
			description: 'Definition of Done. REQUIRED for a delivery Goal; optional seed for a metric Goal.'
		}
	},
	// `title` is the only field required for every kind.
	required: ['title']
};

describe('create_goal tool schema — Goal kinds', () => {
	const converter = new SchemaConverterService();
	const schema = converter.buildToolParameters([], [], CREATE_GOAL_BODY);

	const metricPayload = {
		title: 'Income >= $1000/month',
		metricSource: { pluginId: 'stripe', metricId: 'income' },
		comparator: 'gte',
		targetValue: 1000,
		unit: 'usd',
		window: 'month'
	};

	const deliveryPayload = {
		title: 'Ship feature X across three repos',
		goalKind: 'delivery',
		dodCriteria: [
			{ id: 'api', text: 'API endpoint merged', status: 'open' },
			{ id: 'web', text: 'Web form merged', status: 'open' },
			{ id: 'docs', text: 'Docs updated', status: 'open' }
		]
	};

	it('accepts a classic metric payload with no goalKind at all', () => {
		expect(schema.safeParse(metricPayload).success).toBe(true);
	});

	it('accepts an explicit metric kind', () => {
		expect(schema.safeParse({ ...metricPayload, goalKind: 'metric' }).success).toBe(true);
	});

	it('accepts a delivery payload that carries no metric keys', () => {
		const result = schema.safeParse(deliveryPayload);
		expect(result.success).toBe(true);
		if (result.success) {
			// The parsed object must not have grown metric keys on the way through.
			for (const key of ['metricSource', 'comparator', 'targetValue', 'unit', 'window']) {
				expect(key in result.data).toBe(false);
			}
		}
	});

	it('refuses an unknown goalKind', () => {
		expect(schema.safeParse({ ...deliveryPayload, goalKind: 'bogus' }).success).toBe(false);
	});

	it('refuses a non-numeric targetValue', () => {
		expect(schema.safeParse({ ...metricPayload, targetValue: 'abc' }).success).toBe(false);
	});

	it('refuses an unknown Definition-of-Done status and an empty checklist', () => {
		expect(
			schema.safeParse({
				...deliveryPayload,
				dodCriteria: [{ id: 'a', text: 'x', status: 'finished' }]
			}).success
		).toBe(false);
		expect(schema.safeParse({ ...deliveryPayload, dodCriteria: [] }).success).toBe(false);
	});

	it('no longer lists the four metric names as required', () => {
		// `title` is required for both kinds; every metric field is optional at
		// the schema level because a delivery Goal never sends it.
		expect(schema.safeParse({ title: 'x' }).success).toBe(true);
		expect(CREATE_GOAL_BODY.required).toEqual(['title']);
		for (const key of ['metricSource', 'comparator', 'targetValue', 'unit']) {
			expect(CREATE_GOAL_BODY.required).not.toContain(key);
		}
	});

	it('documents that the per-kind requirement is enforced by the API, not the schema', () => {
		// A metric payload missing its target parses HERE (zod cannot express
		// the cross-field rule) and is refused by the API with a 400 — the
		// tool description is where an agent learns that.
		expect(schema.safeParse({ title: 'x', goalKind: 'metric' }).success).toBe(true);
		expect(CREATE_GOAL_BODY.properties?.metricSource?.description).toContain('required when goalKind is metric');
		expect(CREATE_GOAL_BODY.properties?.goalKind?.description).toContain('supply dodCriteria');
	});
});
