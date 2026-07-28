/**
 * Digest briefings — ORGANIZATION-scoped settings.
 *
 * The per-user cadence (`users.digestFrequency`) predates this file and
 * is deliberately untouched: an org digest is an ADDITION next to the
 * personal one, never a replacement for it. A user can have both, one,
 * or neither.
 *
 * Persisted on `organizations.digest_settings` (nullable simple-json).
 * `null` / absent ⇒ the org digest is OFF, which is every existing row,
 * so the feature ships with no backfill and no behaviour change.
 */

/** How often an organization digest is delivered. */
export const ORGANIZATION_DIGEST_CADENCES = ['daily', 'weekly'] as const;
export type OrganizationDigestCadence = (typeof ORGANIZATION_DIGEST_CADENCES)[number];

/** Weekly by default — an org-wide briefing every morning is noise. */
export const ORGANIZATION_DIGEST_DEFAULT_CADENCE: OrganizationDigestCadence = 'weekly';

/**
 * Per-organization digest settings.
 *
 * `narrative` opts the org into the LLM summary that rides on top of
 * the deterministic counts. It defaults to `true` because the narrative
 * degrades safely on its own — when no AI provider is configured the
 * digest still renders every count, with a visible note explaining that
 * the summary is missing. It is never silently dropped.
 */
export interface OrganizationDigestSettings {
	/** Master switch. Absent / false ⇒ the dispatcher skips this org. */
	enabled?: boolean;
	/** Delivery cadence. Default `weekly`. */
	cadence?: OrganizationDigestCadence;
	/** Include the AI narrative summary. Default `true`. */
	narrative?: boolean;
	/** ISO timestamp of the last delivered pass (written by the dispatcher). */
	lastRunAt?: string | null;
}

/** Interval in whole days for each cadence. */
export const ORGANIZATION_DIGEST_INTERVAL_DAYS: Readonly<Record<OrganizationDigestCadence, number>> = {
	daily: 1,
	weekly: 7
};
