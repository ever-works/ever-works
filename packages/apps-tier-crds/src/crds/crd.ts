/**
 * T3 — the `CustomResourceDefinition` envelope every `hosting.ever.works` kind is wrapped in
 * (APW-10 plan §3:216–221, tasks T3).
 *
 * The manifest type extends `KubernetesObject` from `@kubernetes/client-node` — the client this
 * package's reconcilers use (T6's informers, T11's kind job) — so a manifest built here can be
 * handed to `KubernetesObjectApi.create()` without a cast, and the dependency the task pins
 * (`@kubernetes/client-node`, the same `^1.4.0` `packages/plugins/k8s/package.json` carries) is
 * the one that types this package's Kubernetes surface.
 */
import type { KubernetesObject } from '@kubernetes/client-node';
import { APPS_TIER_API_GROUP, APPS_TIER_API_VERSION } from '@ever-works/contracts';

import type { JsonSchema } from './json-schema.js';

export type { JsonSchema };

/** The CRD API group every manifest is written in. */
export const CRD_API_VERSION = 'apiextensions.k8s.io/v1';

/** The CRD kind every manifest is. */
export const CRD_KIND = 'CustomResourceDefinition';

/** One served version of a CRD (plan §3:216 — `v1alpha1`, and only it). */
export interface CustomResourceDefinitionVersion {
	readonly name: string;
	readonly served: boolean;
	readonly storage: boolean;
	readonly schema: { readonly openAPIV3Schema: JsonSchema };
	/**
	 * Every kind in §3.1–3.2 has a `status` the controller (or the platform, for the two
	 * acknowledgement objects) writes back, so every one of them serves the status subresource:
	 * a `Work` cannot be patched into a new generation through its status, and a status write
	 * cannot race the spec.
	 */
	readonly subresources: { readonly status: Record<string, never> };
}

/** The `spec` of a CRD manifest. */
export interface CustomResourceDefinitionSpec {
	readonly group: string;
	readonly names: {
		readonly kind: string;
		readonly listKind: string;
		readonly plural: string;
		readonly singular: string;
	};
	/** §3:220 — "All kinds are **namespaced** in the control namespace". */
	readonly scope: 'Namespaced';
	readonly versions: readonly CustomResourceDefinitionVersion[];
}

/** A complete CRD manifest, ready to be written to `deploy/crds/` and applied. */
export interface CustomResourceDefinitionManifest extends KubernetesObject {
	readonly apiVersion: typeof CRD_API_VERSION;
	readonly kind: typeof CRD_KIND;
	readonly metadata: { readonly name: string };
	readonly spec: CustomResourceDefinitionSpec;
}

/** What a kind module declares: its names and its root schema. */
export interface CrdDefinition {
	readonly kind: string;
	readonly plural: string;
	readonly singular: string;
	readonly openAPIV3Schema: JsonSchema;
}

/**
 * The root `openAPIV3Schema` of a kind.
 *
 * `apiVersion`, `kind` and `metadata` are declared but unconstrained: a structural schema may only
 * restrict root metadata's `name`/`generateName`, and the platform writes neither (the name is
 * `w-<workId>`, written by the API client). `additionalProperties` is deliberately **absent** from
 * this object — the apiserver forbids it at the root of a structural schema — and lives on the
 * `spec`/`status` schemas instead, where it is what refuses an unknown field (ACC-10-26).
 *
 * `spec` is required and `status` is not: a `Work` is created as desired state and its status is
 * written afterwards by the controller (spec FR-27, plan §3.1:254).
 */
export function rootSchema(kind: string, spec: JsonSchema, status: JsonSchema): JsonSchema {
	return {
		type: 'object',
		description: `A \`${kind}\` object of the Ever Works Apps hosting tier (group \`${APPS_TIER_API_GROUP}\`).`,
		required: ['spec'],
		properties: {
			apiVersion: {
				type: 'string',
				description: `Always \`${APPS_TIER_API_GROUP}/${APPS_TIER_API_VERSION}\`.`
			},
			kind: { type: 'string', description: `Always \`${kind}\`.` },
			metadata: {
				type: 'object',
				description: 'Standard object metadata; the platform writes `name` and the control namespace.'
			},
			spec,
			status
		}
	};
}

/**
 * Wrap a kind's schemas in the CRD envelope (plan §3:218–221).
 *
 * `metadata.name` is `<plural>.<group>`, both versions flags are `true` (the one version is served
 * and stored), and the status subresource is enabled for all five kinds.
 */
export function customResourceDefinition(definition: CrdDefinition): CustomResourceDefinitionManifest {
	return {
		apiVersion: CRD_API_VERSION,
		kind: CRD_KIND,
		metadata: { name: `${definition.plural}.${APPS_TIER_API_GROUP}` },
		spec: {
			group: APPS_TIER_API_GROUP,
			names: {
				kind: definition.kind,
				listKind: `${definition.kind}List`,
				plural: definition.plural,
				singular: definition.singular
			},
			scope: 'Namespaced',
			versions: [
				{
					name: APPS_TIER_API_VERSION,
					served: true,
					storage: true,
					schema: { openAPIV3Schema: definition.openAPIV3Schema },
					subresources: { status: {} }
				}
			]
		}
	};
}
