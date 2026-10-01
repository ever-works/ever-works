/**
 * T3 — the `AbuseSignal` CRD (APW-10 plan §3.2:305–306, tasks T3, T29).
 *
 * The zone's signal rules raise one of these; the platform's importer reads it, an operator
 * dismisses or quarantines it, and the acknowledgement is written back to `status`. `kind` and
 * `severity` are T1's closed sets rather than inline lists, and `summary` is capped at
 * `APPS_TIER_SIGNAL_SUMMARY_MAX_CHARS` — a summary summarises, so it must never quote an
 * environment value or a credential (plan §3.2:306, spec FR-37).
 *
 * `test: true` marks LG-19's benign sensor trigger: a real row and a real acknowledgement, never a
 * real quarantine (T29).
 */
import {
	APPS_TIER_SIGNAL_KINDS,
	APPS_TIER_SIGNAL_SEVERITIES,
	APPS_TIER_SIGNAL_SUMMARY_MAX_CHARS
} from '@ever-works/contracts';

import type { CrdDefinition, CustomResourceDefinitionManifest } from './crd.js';
import { customResourceDefinition, rootSchema } from './crd.js';
import { UUID_PATTERN, closedObject, nullableStringSchema, stringSchema } from './json-schema.js';

/** `AbuseSignal` — plan §3.2:305–306. */
export const ABUSE_SIGNAL_CRD_DEFINITION: CrdDefinition = {
	kind: 'AbuseSignal',
	plural: 'abusesignals',
	singular: 'abusesignal',
	openAPIV3Schema: rootSchema(
		'AbuseSignal',
		closedObject(
			{
				workId: stringSchema({ description: 'The Work the signal is about.', pattern: UUID_PATTERN }),
				kind: {
					type: 'string',
					enum: APPS_TIER_SIGNAL_KINDS,
					description: '`runtime` | `mining` | `mail` | `bandwidth` | `report` (plan §3.2:305, T1).'
				},
				severity: {
					type: 'string',
					enum: APPS_TIER_SIGNAL_SEVERITIES,
					description: '`low` | `medium` | `high`.'
				},
				observedAt: stringSchema({ description: 'When the rule fired.', minLength: 20, maxLength: 40 }),
				summary: stringSchema({
					description: `A secret-free summary, at most ${APPS_TIER_SIGNAL_SUMMARY_MAX_CHARS} characters — spec FR-37.`,
					maxLength: APPS_TIER_SIGNAL_SUMMARY_MAX_CHARS
				}),
				ruleId: stringSchema({
					description: 'The rule that raised it (T29’s `signal-rules.ts`).',
					minLength: 1,
					maxLength: 128
				}),
				test: {
					type: 'boolean',
					description: 'The LG-19 sensor trigger’s benign signal — never a real quarantine (T29).'
				}
			},
			{
				description: 'One signal, raised inside the zone.',
				required: ['workId', 'kind', 'severity', 'observedAt', 'summary', 'ruleId', 'test']
			}
		),
		closedObject(
			{
				acknowledgedAt: nullableStringSchema('When the platform acknowledged the signal; `null` until it did.'),
				autoQuarantined: {
					type: 'boolean',
					description: 'Whether the zone quarantined the Work on this signal (plan §3.2:306).'
				}
			},
			{ description: 'Written by the platform when it reads the signal (T29).' }
		)
	)
};

/** The `AbuseSignal` CRD manifest, as `deploy/crds/abusesignal.yaml` carries it. */
export const ABUSE_SIGNAL_CRD: CustomResourceDefinitionManifest = customResourceDefinition(ABUSE_SIGNAL_CRD_DEFINITION);
