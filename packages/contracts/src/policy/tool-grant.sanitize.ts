import type { ToolGrantOverride } from './tool-grant.types.js';
import { TOOL_GRANT_PATTERN } from './tool-grant.types.js';

/**
 * Tool-grant matrix (audit item G4) — the shape guard for a stored
 * override.
 *
 * Same posture (and same reasons) as `sanitizeMergePolicyOverride`: it
 * lives next to the type because every writer needs it — the API upsert
 * endpoint, the agent-side service, any future importer — and none of them
 * should drag the entity graph in just to validate two string arrays.
 *
 * Rules:
 *  - A non-string or malformed pattern is DROPPED, never coerced. A junk
 *    entry must not become a permissive `*`.
 *  - A declared-but-EMPTY `allow` is meaningful and kept: it means "this
 *    scope grants nothing", which is the strongest possible narrowing.
 *  - A declared-but-entirely-invalid `allow` is dropped (→ "inherit"),
 *    because silently turning garbage into "grant nothing" would break a
 *    running tenant on a typo.
 *  - `deny` follows the same rules; dropping a bad deny is safe because a
 *    deny only ever subtracts.
 */
export function sanitizeToolGrantOverride(raw: ToolGrantOverride | null | undefined): ToolGrantOverride {
	if (!raw || typeof raw !== 'object') return {};
	const out: ToolGrantOverride = {};

	for (const key of ['allow', 'deny'] as const) {
		const value = raw[key];
		if (!Array.isArray(value)) continue;
		const patterns = value
			.filter((p): p is string => typeof p === 'string')
			.map((p) => p.trim())
			.filter((p) => p.length > 0 && TOOL_GRANT_PATTERN.test(p));
		if (patterns.length > 0 || value.length === 0) {
			out[key] = Array.from(new Set(patterns));
		}
	}

	return out;
}
