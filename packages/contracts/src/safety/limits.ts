/**
 * Safety rails (AW-24) — every number the epic promises, in one file.
 *
 * Each of these appears in a sentence the product says out loud: "held for
 * 14 days", "50 per page", "kept for 90 days", "within 10 seconds". A number
 * that lives in two files eventually means two different things, and the
 * screen would then be making a claim the enforcement no longer honours.
 */

/** A held action expires this many days after it was held (FR-25). */
export const HELD_ACTION_EXPIRY_DAYS = 14;

/** Its owner is warned this many days after it was held (FR-25). */
export const HELD_ACTION_WARN_DAYS = 7;

/**
 * How long a resolved ladder / pause snapshot may be served before it is
 * refreshed (FR-20, FR-37). Ten seconds is the whole "takes effect without a
 * restart" budget, and it needs no pub/sub to honour.
 */
export const SAFETY_CACHE_TTL_MS = 10_000;

/** How long a paused workspace waits for a run to reach a tool boundary (FR-43). */
export const PAUSE_INFLIGHT_GRACE_MS = 30_000;

/** Parked work is promoted in batches of this size on resume (FR-49). */
export const RESUME_BATCH_SIZE = 50;

/** …one batch per this interval (FR-49). */
export const RESUME_BATCH_INTERVAL_MS = 10_000;

/** Refusals are read this many per page (FR-66). */
export const RAIL_REFUSAL_PAGE_SIZE = 50;

/** …and kept for this many days, pruned daily (FR-67). */
export const RAIL_REFUSAL_RETENTION_DAYS = 90;

/**
 * How many expired refusals one prune pass deletes per statement (FR-67).
 *
 * Bounded rather than a single unqualified `DELETE`: one misconfigured agent
 * can write hundreds of thousands of rows inside the retention window, and the
 * table the nightly pass walks is the same one the Safety screen reads. A
 * batched delete keeps the lock windows short enough that the prune is never
 * the reason the log will not load.
 */
export const RAIL_REFUSAL_PRUNE_BATCH_SIZE = 5_000;

/**
 * The most batches one nightly prune pass will run before it stops and leaves
 * the rest to tomorrow.
 *
 * A backlog is a reason to take longer, never a reason to hold the lock all
 * night: at the batch size above this is 1,000,000 rows per pass, and a
 * workspace that somehow exceeds that is one whose prune should be visible in
 * the logs rather than silently running until morning.
 */
export const RAIL_REFUSAL_PRUNE_MAX_BATCHES = 200;

/**
 * More than this many refusals from the same rail, agent and category in one
 * calendar day collapse into a single row with a count (FR-68). A
 * misconfigured agent must not be able to bury the log it is the evidence in.
 */
export const RAIL_REFUSAL_COLLAPSE_THRESHOLD = 50;

/** A refusal's summary is capped here — never a body, never arguments (FR-70). */
export const RAIL_REFUSAL_SUMMARY_MAX = 500;

/** A pause reason is capped here (FR-48). */
export const WORKSPACE_PAUSE_REASON_MAX = 500;

/** Readiness is computed over this trailing window (FR-35). */
export const READINESS_WINDOW_DAYS = 30;

/** …needs at least this many answered decisions (FR-35). */
export const READINESS_MIN_DECISIONS = 20;

/** …at least this approval rate (FR-35). */
export const READINESS_MIN_APPROVAL_RATE = 0.95;

/** A held action is stale when its priced amount moved by more than this (FR-26). */
export const STALE_PRICE_DELTA = 0.1;

/** Rung writes are rate-limited to this many per minute (FR-78). */
export const SAFETY_RUNG_WRITES_PER_MINUTE = 30;

/** Pause and resume to this many per minute (FR-78). */
export const SAFETY_PAUSE_WRITES_PER_MINUTE = 10;

/** Cancel-in-flight to this many per minute (FR-78). */
export const SAFETY_CANCEL_WRITES_PER_MINUTE = 5;

/**
 * What happens to an action the platform could not classify (FR-24).
 *
 *  - `warn`   — it proceeds, and is counted. This is P1: the bundled plugins
 *    have not declared their categories yet, and refusing everything they
 *    expose would take working installs down on the day this ships.
 *  - `refuse` — it is refused and one decision is raised naming the tool.
 *    P3 flips this constant once every bundled plugin declares.
 *
 * Deliberately one exported constant rather than an environment variable: the
 * cut-over is a product decision with a test pinning each side of it, not a
 * per-deployment knob that would make the guarantee mean different things on
 * different installs.
 */
export const UNCLASSIFIED_ACTION_POLICY: 'warn' | 'refuse' = 'warn';

/**
 * What a rung NOBODY SET does — the shipped default for a category with no
 * stored row at any scope.
 *
 *  - `display` — the default is shown on the ladder (so a new workspace can
 *    see where it starts) but the rail does not act on it. This is P1: the
 *    hold-and-execute half does not exist yet, so a shipped default of
 *    `draft` or `ask` would stop work that runs today and leave nothing that
 *    could ever release it. Program rule: additive only, nothing gets worse.
 *  - `enforce` — the default is a rail like any other. P2 flips this the
 *    moment an approval actually executes the stored action, because from
 *    then on a hold is a pause rather than a dead end.
 *
 * An EXPLICIT rung is always enforced, under either policy. This constant
 * governs only the untouched default, and it is one exported value with a
 * test on each side of it — the same phasing idiom as
 * {@link UNCLASSIFIED_ACTION_POLICY} — rather than a per-deployment knob that
 * would make the guarantee mean different things on different installs.
 */
export const SHIPPED_DEFAULT_RUNG_POLICY: 'display' | 'enforce' = 'display';
