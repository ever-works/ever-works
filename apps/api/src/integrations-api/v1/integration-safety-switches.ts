/**
 * Works-security lane (integration API gates, 2026-10-18) — the operator
 * switches of `/api/integrations/v1` rules that keep a key (no person behind
 * it) from deciding what a person decides: signing off a Goal's definition of
 * done, accepting a Knowledge Base document, rewriting the instructions of an
 * autonomous Mission or of a running Goal.
 *
 * Every switch is DEFAULT-SAFE and fails safe: a default-on rule is turned off
 * only by the exact value `false`, a default-off relaxation is turned on only by
 * the exact value `true`. A typo, an empty value or an unset variable keeps the
 * safe behaviour. Nothing is removed: each switch restores the previous
 * behaviour for an operator who decides they need it.
 *
 * Read per request (not cached), so a test or an operator's restart picks a
 * change up without a code path that could keep a stale value.
 */

type Env = Readonly<Record<string, string | undefined>>;

function normalized(env: Env, name: string): string {
    return (env[name] ?? '').trim().toLowerCase();
}

/** A rule that is ON unless the variable is exactly `false`. */
function onUnlessFalse(env: Env, name: string): boolean {
    return normalized(env, name) !== 'false';
}

/** A relaxation that is OFF unless the variable is exactly `true`. */
function offUnlessTrue(env: Env, name: string): boolean {
    return normalized(env, name) === 'true';
}

/**
 * `INTEGRATION_GOAL_DOD_PROPOSE_ONLY` (default `true`). Without `X-Act-As-User`
 * an integration key may only PROPOSE Definition-of-Done criteria (open,
 * awaiting a person's approval): it may not mark one done or waived, change or
 * remove an approved one, or approve a proposal by naming it — on
 * `PUT /goals/:id/dod` and on `POST /goals`. A relayed person's write (act-as)
 * keeps the previous behaviour (owner decision).
 */
export function integrationGoalDodProposeOnly(env: Env = process.env): boolean {
    return onUnlessFalse(env, 'INTEGRATION_GOAL_DOD_PROPOSE_ONLY');
}

/**
 * `INTEGRATION_KB_ACCEPT_REQUIRES_PERSON` (default `true`).
 * `POST /kb/documents/:id/accept` relays a PERSON's review decision: it needs
 * `X-Act-As-User`, and it never accepts content whose latest write was made by
 * an integration key acting as itself (that content is accepted by a person in
 * Ever Works, or re-sent as a person's write).
 */
export function integrationKbAcceptRequiresPerson(env: Env = process.env): boolean {
    return onUnlessFalse(env, 'INTEGRATION_KB_ACCEPT_REQUIRES_PERSON');
}

/**
 * `INTEGRATION_MISSION_EDIT_PAUSED_ONLY` (default `true`). An integration may
 * change a Mission's title or description only while the Mission does not tick
 * (paused, or already completed / failed — never `active`): an active Mission
 * feeds its description to the Idea generator at every tick and can queue
 * builds from the result.
 */
export function integrationMissionEditPausedOnly(env: Env = process.env): boolean {
    return onUnlessFalse(env, 'INTEGRATION_MISSION_EDIT_PAUSED_ONLY');
}

/**
 * `INTEGRATION_GOAL_TEXT_EDIT_RUNNING` (default `false`). While a Goal's
 * execution loop is running, an integration key without `X-Act-As-User` may not
 * change its title or description (every iteration brief is built from them).
 * `true` restores the previous behaviour.
 */
export function integrationGoalTextEditRunning(env: Env = process.env): boolean {
    return offUnlessTrue(env, 'INTEGRATION_GOAL_TEXT_EDIT_RUNNING');
}
