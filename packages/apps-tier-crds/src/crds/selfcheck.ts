/**
 * T3 — the `SelfCheck` CRD (APW-10 plan §3.2:299–301, tasks T3, T9).
 *
 * A `SelfCheck` is the platform's request for one launch-gate run and the zone's answer to it: the
 * platform writes `spec` (which items to run), the controller writes `status` (what each item
 * answered). `status` is mirrored field-for-field from the plugin-facing contract
 * `AppsTierSelfCheckStatus` (`packages/plugin/src/contracts/capabilities/apps-tier.types.ts`) —
 * the same object `getSelfCheck(runId)` returns (T2, landed) — so the zone's stored run and the
 * value the platform reads back cannot drift; `results[]` is T1's `AppsTierSelfCheckResult`.
 *
 * `spec.items` is the closed `LAUNCH_GATE_ITEM_IDS` set rather than a free string: an item id the
 * registry does not know is a bug, not data, and the enum is what makes the CRD say so.
 */
import type { AppsTierSelfCheckResult } from '@ever-works/contracts';
import { APPS_TIER_PROBE_REASON_CODES, LAUNCH_GATE_ITEM_IDS, LAUNCH_GATE_OUTCOMES } from '@ever-works/contracts';
import type { AppsTierSelfCheckStatus } from '@ever-works/plugin';
import { APPS_TIER_SELF_CHECK_PHASES } from '@ever-works/plugin';

import type { CrdDefinition, CustomResourceDefinitionManifest, JsonSchema } from './crd.js';
import { customResourceDefinition, rootSchema } from './crd.js';
import {
	UUID_PATTERN,
	arrayOf,
	closedObject,
	integerSchema,
	nullableStringSchema,
	stringSchema
} from './json-schema.js';

/** One item's result — `AppsTierSelfCheckResult` (plan §3.2:299–301). */
const SELF_CHECK_RESULT_PROPERTIES: Record<keyof AppsTierSelfCheckResult, JsonSchema> = {
	id: { type: 'string', enum: LAUNCH_GATE_ITEM_IDS, description: 'The launch-gate item id (LG-01…LG-25).' },
	outcome: {
		type: 'string',
		enum: LAUNCH_GATE_OUTCOMES,
		description: '`passed` | `failed` | `inconclusive` | `error` — plan §3.7:472–473.'
	},
	reasonCode: {
		type: ['string', 'null'],
		enum: [...APPS_TIER_PROBE_REASON_CODES, null],
		description: 'Why the item answered what it did; `null` when it passed.'
	},
	durationMs: integerSchema({ description: 'How long the item took.', minimum: 0 })
};

/** `SelfCheck.status` — `AppsTierSelfCheckStatus` (plan §3.2:299–301). */
const SELF_CHECK_STATUS_PROPERTIES: Record<keyof AppsTierSelfCheckStatus, JsonSchema> = {
	phase: { type: 'string', enum: APPS_TIER_SELF_CHECK_PHASES, description: '`Running` | `Completed` | `Failed`.' },
	startedAt: nullableStringSchema('When the run started; `null` before it did.'),
	finishedAt: nullableStringSchema('When the run finished; `null` while it is `Running`.'),
	results: arrayOf(
		closedObject(SELF_CHECK_RESULT_PROPERTIES, { required: ['id', 'outcome', 'reasonCode', 'durationMs'] }),
		{
			description: 'One row per item the run covered (plan §3.2:300–301).',
			maxItems: LAUNCH_GATE_ITEM_IDS.length
		}
	),
	policyRevision: stringSchema({
		description: 'The zone policy revision the run was taken on — spec FR-4.',
		maxLength: 64
	}),
	controllerVersion: stringSchema({ description: 'The controller version that ran it.', maxLength: 64 })
};

/** `SelfCheck` — plan §3.2. */
export const SELF_CHECK_CRD_DEFINITION: CrdDefinition = {
	kind: 'SelfCheck',
	plural: 'selfchecks',
	singular: 'selfcheck',
	openAPIV3Schema: rootSchema(
		'SelfCheck',
		closedObject(
			{
				runId: stringSchema({
					description: 'The gate run this answers — the platform’s `apps_tier_gate_runs.id` (plan §3.2:299).',
					pattern: UUID_PATTERN
				}),
				items: {
					type: 'array',
					description: 'The items the platform asks the zone to run (plan §3.2:299).',
					minItems: 1,
					maxItems: LAUNCH_GATE_ITEM_IDS.length,
					items: { type: 'string', enum: LAUNCH_GATE_ITEM_IDS }
				},
				requestedAt: stringSchema({
					description: 'When the platform requested the run.',
					minLength: 20,
					maxLength: 40
				})
			},
			{
				description: 'What to check — written by the platform.',
				required: ['runId', 'items', 'requestedAt']
			}
		),
		closedObject(SELF_CHECK_STATUS_PROPERTIES, {
			description: 'What the zone found — written by the controller (T9).'
		})
	)
};

/** The `SelfCheck` CRD manifest, as `deploy/crds/selfcheck.yaml` carries it. */
export const SELF_CHECK_CRD: CustomResourceDefinitionManifest = customResourceDefinition(SELF_CHECK_CRD_DEFINITION);
