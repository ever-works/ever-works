import type { MergeMethod, MergePolicyOverride } from './merge-policy.types.js';

/**
 * Merge-policy matrix (Wave 3, founder decision D4) — the shape guard for
 * a stored override.
 *
 * It lives HERE, next to the type, rather than in `@ever-works/agent`,
 * because it is a property of the WIRE SHAPE and every writer needs it:
 * the Work/Agent update paths in the agent package, the organization
 * update path in the API, and any future importer. Reaching for the agent
 * package just to validate a five-field JSON object would drag the whole
 * entity graph into callers that only ever touch the contract.
 *
 * `simple-json` columns round-trip whatever was written, and API bodies /
 * import payloads can carry junk, so every field is validated on the way
 * IN to resolution. An invalid value is DROPPED (which means "inherit"),
 * never coerced to a permissive default — the same drop-if-unrecognized
 * posture the account import uses for enums, and the only safe one for a
 * field that can loosen enforcement.
 */
export function sanitizeMergePolicyOverride(raw: MergePolicyOverride | null | undefined): MergePolicyOverride {
	if (!raw || typeof raw !== 'object') return {};
	const out: MergePolicyOverride = {};

	for (const key of ['allowAgentMerge', 'requireGreenGate', 'requireHumanApproval'] as const) {
		if (typeof raw[key] === 'boolean') out[key] = raw[key];
	}

	if (Array.isArray(raw.allowedMergeMethods)) {
		const methods = raw.allowedMergeMethods.filter(
			(m): m is MergeMethod => m === 'merge' || m === 'squash' || m === 'rebase'
		);
		// A declared-but-fully-invalid list is dropped; a declared EMPTY
		// list is meaningful ("no method is allowed") and kept.
		if (methods.length > 0 || raw.allowedMergeMethods.length === 0) {
			out.allowedMergeMethods = Array.from(new Set(methods));
		}
	}

	if (Array.isArray(raw.protectedBranches)) {
		const branches = raw.protectedBranches
			.filter((b): b is string => typeof b === 'string')
			.map((b) => b.trim())
			.filter((b) => b.length > 0);
		// Same rule: an explicitly empty list means "protect nothing".
		if (branches.length > 0 || raw.protectedBranches.length === 0) {
			out.protectedBranches = Array.from(new Set(branches));
		}
	}

	return out;
}
