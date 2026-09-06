/**
 * Work "kind" vocabulary — the single source of truth shared by the API,
 * the agent package and the web app.
 *
 * This lives in `@ever-works/contracts` rather than in the TypeORM entity
 * because `apps/web` deliberately does not depend on `@ever-works/agent`;
 * contracts is the only package both sides import at runtime. The entity
 * (`packages/agent/src/entities/work.entity.ts`) re-exports from here so
 * there is exactly one list to extend when a new kind ships.
 */

/**
 * Kinds a user can pick from the chip catalog at creation time.
 *
 * `company` is deliberately absent: Company Works are minted only through
 * the dedicated Register-Company flow (`WorkLifecycleService.createCompanyWork`),
 * never through the general create path.
 *
 * `repo` (chip label "Repository") is the one selectable kind that is NOT a
 * generated site: it registers an EXISTING code repository — the platform
 * monorepo, a template repo, a website repo — as a first-class Work so
 * Tasks, Goals and fleet runs can attach to it (self-build slice D,
 * EW-766). Its data repository IS the code repository; see
 * `WORK_KIND_CAPABILITIES.repo`.
 */
export const USER_SELECTABLE_WORK_KINDS = [
	'website',
	'landing-page',
	'blog',
	'directory',
	'awesome-repo',
	'repo'
] as const;

export type UserSelectableWorkKind = (typeof USER_SELECTABLE_WORK_KINDS)[number];

/**
 * Every kind a persisted `work.kind` may hold.
 *
 *   - `default` — the column default. Carried by every Work created before
 *     the kind-aware create path shipped, which is the overwhelming majority
 *     of existing rows. It must behave identically to `directory`; see
 *     `WORK_KIND_CAPABILITIES` for why that invariant is load-bearing.
 *   - `company` — see above.
 *   - `campaign` — a go-to-market campaign Work: the artifact home for the
 *     lead lists, drafts, and reports a go-to-market pipeline produces. Like
 *     `company` it is minted by a dedicated flow (template activation), not
 *     by the general create path, so it stays out of the chip catalog.
 */
export const WORK_KINDS = [...USER_SELECTABLE_WORK_KINDS, 'company', 'campaign', 'default'] as const;

export type WorkKind = (typeof WORK_KINDS)[number];

const WORK_KIND_SET: ReadonlySet<string> = new Set<string>(WORK_KINDS);

/**
 * Coerce an arbitrary value into a known `WorkKind`.
 *
 * `work.kind` is persisted as `varchar(32)` and modelled as an open string
 * union so the server can ship a new kind without a coordinated web deploy.
 * Every consumer must therefore route unknown values through here and get
 * the safe generic `default` behaviour rather than crashing or silently
 * mis-rendering.
 *
 * `landing` is accepted as an alias for `landing-page`.
 *
 * NEVER throws.
 */
export function normalizeWorkKind(value?: string | null): WorkKind {
	if (typeof value !== 'string') {
		return 'default';
	}
	const normalized = value.trim().toLowerCase();
	if (!normalized) {
		return 'default';
	}
	const canonical = normalized === 'landing' ? 'landing-page' : normalized;
	return WORK_KIND_SET.has(canonical) ? (canonical as WorkKind) : 'default';
}

/** True when `value` is a kind the create-path chip catalog offers. */
export function isUserSelectableWorkKind(value?: string | null): value is UserSelectableWorkKind {
	if (typeof value !== 'string') {
		return false;
	}
	const canonical = value.trim().toLowerCase() === 'landing' ? 'landing-page' : value.trim().toLowerCase();
	return (USER_SELECTABLE_WORK_KINDS as readonly string[]).includes(canonical);
}

/**
 * True when `value` names the Repository kind (`repo`) — the one kind whose
 * data repository is a code repository the user already owns rather than
 * something the platform generated (self-build slice D, EW-766).
 *
 * This is deliberately a KIND test rather than a capability test. The
 * content pipelines (item generation, README regeneration, deployment) are
 * not capability-gated for any kind today; what is special about a
 * Repository Work is not "it has no items" — a Company Work has none either
 * — but that running the directory pipeline against its data repository
 * would write generated scaffolding into a human's source tree. Callers
 * that must never touch that repository check this predicate. Accepts the
 * same loose input as `normalizeWorkKind` and never throws.
 */
export function isRepositoryWorkKind(value?: string | null): boolean {
	return normalizeWorkKind(value) === 'repo';
}
