/**
 * T3 — the `UsageReport` CRD (APW-10 plan §3.2:302–304, tasks T3, T28).
 *
 * `name` is `ur-<workId>-<windowStart epoch>` (plan §3.2:302) and is the only handle the platform
 * acknowledges a report by, so the naming pattern is stated here in the object's own description
 * rather than left to a caller.
 *
 * ## Five metered units, or seven
 *
 * Plan §3.2:303 names five quantities; `AppsTierUsageReport` — the plugin-facing projection T2
 * landed — carries seven, because XC-20 bills the two dependency units through
 * `hosting.dependency_storage_gib_hour` / `hosting.dependency_backup_gib_hour` (plan §5.3:665–666)
 * and a unit that never arrives on a report can never be billed. All seven are declared here, the
 * five the plan names are required, and the two XC-20 additions are optional: a report written by
 * a plan-literal reporter is stored rather than refused, and the platform's importer still reads
 * the units the pricebook knows (`metering.service`, T28).
 */
import type { AppsTierUsageReport } from '@ever-works/plugin';

import type { CrdDefinition, CustomResourceDefinitionManifest, JsonSchema } from './crd.js';
import { customResourceDefinition, rootSchema } from './crd.js';
import { UUID_PATTERN, closedObject, integerSchema, nullableStringSchema, stringSchema } from './json-schema.js';

/**
 * The metered quantities, taken from the projection's own keys: a member of `AppsTierUsageReport`
 * that is neither identity nor acknowledgement is a unit, so a unit cannot be dropped from the
 * report without this module failing to compile.
 */
type MeteredUnitField = Exclude<
	keyof AppsTierUsageReport,
	'name' | 'workId' | 'windowStart' | 'windowEnd' | 'acknowledgedAt'
>;

/** `UsageReport.spec` — plan §3.2:302–304, plus XC-20's two dependency units. */
const USAGE_REPORT_SPEC_PROPERTIES: Record<'workId' | 'windowStart' | 'windowEnd' | MeteredUnitField, JsonSchema> = {
	workId: stringSchema({ description: 'The Work the window belongs to.', pattern: UUID_PATTERN }),
	windowStart: stringSchema({ description: 'The window’s start instant.', minLength: 20, maxLength: 40 }),
	windowEnd: stringSchema({ description: 'The window’s end instant.', minLength: 20, maxLength: 40 }),
	cpuCoreSeconds: integerSchema({ description: 'Metered CPU, in core-seconds (plan §3.2:303).', minimum: 0 }),
	memoryMiBHours: integerSchema({ description: 'Metered memory, in MiB-hours.', minimum: 0 }),
	egressMiB: integerSchema({ description: 'Metered egress, in MiB.', minimum: 0 }),
	storageGiBHours: integerSchema({ description: 'Metered volume storage, in GiB-hours.', minimum: 0 }),
	buildMinutes: integerSchema({ description: 'Metered build minutes (P3 builds included).', minimum: 0 }),
	dependencyStorageGiBHours: integerSchema({ description: 'XC-20 — dependency storage, in GiB-hours.', minimum: 0 }),
	dependencyBackupGiBHours: integerSchema({ description: 'XC-20 — dependency backup, in GiB-hours.', minimum: 0 })
};

/** `UsageReport` — plan §3.2. */
export const USAGE_REPORT_CRD_DEFINITION: CrdDefinition = {
	kind: 'UsageReport',
	plural: 'usagereports',
	singular: 'usagereport',
	openAPIV3Schema: rootSchema(
		'UsageReport',
		closedObject(USAGE_REPORT_SPEC_PROPERTIES, {
			description:
				'One hour of metered usage, named `ur-<workId>-<windowStart epoch>` (plan §3.2:302). Whole numbers only — a sub-unit remainder is carried to the next window (plan §5.3:664–665).',
			required: [
				'workId',
				'windowStart',
				'windowEnd',
				'cpuCoreSeconds',
				'memoryMiBHours',
				'egressMiB',
				'storageGiBHours',
				'buildMinutes'
			]
		}),
		closedObject(
			{
				acknowledgedAt: nullableStringSchema('When the platform imported the report; `null` until it did.')
			},
			{
				description:
					'Written by the platform’s metering import (T28). The zone garbage-collects a report 7 days after this is set (plan §3.2:304).'
			}
		)
	)
};

/** The `UsageReport` CRD manifest, as `deploy/crds/usagereport.yaml` carries it. */
export const USAGE_REPORT_CRD: CustomResourceDefinitionManifest = customResourceDefinition(USAGE_REPORT_CRD_DEFINITION);
