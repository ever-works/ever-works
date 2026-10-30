import {
    FLEET_AGENT_TASK_MAX_SETUP_STEPS,
    isRepoDeclaredCommandAllowed,
    normalizeRepoDeclaredCommand,
    repoDeclaredCommandId,
    REPO_DECLARED_COMMANDS_MAX,
    type GateStatus,
    type TaskAcceptanceCheck,
    type TaskCheckPhase,
    type TaskCheckResult,
    type WorkRepoDeclaredCommandPolicy,
} from '@ever-works/contracts';

/**
 * Repository-declared commands — the strict reader and the admission gate
 * (EW-807, slice AA).
 *
 * ## What sits here and why it is not in `works-config`
 *
 * `WorksConfigService` reads `.works/works.yml` on the import, sync and
 * generation paths, and it NEVER THROWS by design: a schema complaint in
 * a user's own repository must not be able to take their Work offline, so
 * validation there is advisory and the raw `spec` block is carried
 * through even when it failed validation
 * (`works-config.service.ts:readSchemaFields`).
 *
 * That posture is exactly wrong for an execution gate. "I could not
 * understand what you asked me to verify, so I verified nothing and
 * called the run green" is the silent fallback this slice exists to
 * delete. So the reader here is a SEPARATE, strict one: every failure is
 * a throw, the caller (`FleetAgentTaskPlannerService`) does not catch it,
 * and the run fails on its own row where an owner can read why.
 *
 * ## What a repository may declare, and what it may not
 *
 * MAY: a command string that appears VERBATIM on the Work owner's
 * allow-list, optionally naming which mounted repository it runs in and a
 * human-readable label.
 *
 * MAY NOT: anything else. Not a command that merely starts with an
 * allow-listed one; not a check id (ids are generated from the
 * declaration's position, because an id is the merge key and a chosen id
 * would let a repository suppress an owner's check); not `required:
 * false` (a declared check is a check); not an env grant; not a timeout
 * beyond the runner's own; not a `cwd` outside the worktree — `cwd` is
 * not accepted at all, because the `mount:` selector covers the real need
 * and a path is a strictly larger attack surface than a name.
 *
 * ## An App Work reads `spec.checks` instead (APW-08 T13)
 *
 * For `kind: 'app'` the `spec` block is the App spec, whose quality gates
 * live in `spec.checks[]` (`AppSpecCheck`: `name`, `command`, `required`,
 * `timeoutSeconds`) rather than in `spec.tasks`. Three things differ from
 * the repository case, and nothing else does:
 *
 *  - **`required` and `timeoutSeconds` are honoured.** The App spec is the
 *    member's own declaration of which checks decide the gate (FR-16), and
 *    APW-03's schema owns both fields and their bounds (60–7,200 seconds,
 *    default 1,800). The id is STILL the parser's `repo/` + position and
 *    never anything derived from `name` (APW08-G03): ids are the merge key
 *    with owner-authored checks and the node's authorship marker for
 *    withholding run env grants, so an App spec check named like an owner
 *    check cannot replace, suppress or inherit it.
 *  - **The 21st check and later are ignored, not refused** — the same cap,
 *    from the front, that `AppWorkRulesService` applies to the run's rules,
 *    so the checks this reads are the checks the run brief names.
 *  - **A command the owner has not admitted is reported, not refused**
 *    (FR-14). Refusing would mean one un-reviewed check blocks every evolve
 *    run; dropping it would grade the run green having verified less. So it
 *    comes back as a `not-admitted` entry, never executes, and
 *    {@link foldNotAdmittedChecks} keeps a required one from grading green.
 */

/** Every failure is a refusal that fails the RUN. Nothing here degrades. */
export class RepoDeclaredCommandsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RepoDeclaredCommandsError';
    }
}

/** One command as the repository wrote it, after shape validation. */
export interface RepoDeclaredCommand {
    /** Normalized by `normalizeRepoDeclaredCommand` — the exact string that will run. */
    command: string;
    /** `mountDir` of a mounted repository; the primary worktree when absent. */
    mountDir?: string;
    /** Label for run reports; falls back to the command. */
    name?: string;
    /**
     * APW-08 T13 — App spec checks only. `false` is an advisory check
     * (`AppSpecCheck.required: false`); a repository's `spec.tasks` entry
     * never carries this and is always required.
     */
    required?: boolean;
    /** APW-08 T13 — App spec checks only: `timeoutSeconds`, 60–7,200. */
    timeoutSec?: number;
}

/** What `spec.tasks` declared, per phase. */
export interface RepoDeclaredCommandSet {
    setup: RepoDeclaredCommand[];
    checks: RepoDeclaredCommand[];
}

/** Label cap; mirrors `AcceptanceCheckDto.name`, which these become. */
const NAME_MAX_LENGTH = 120;

/**
 * Read `spec.tasks.{setup,checks}` out of a parsed `.works/works.yml`.
 *
 * Accepts either spelling the schema allows — a bare command string, or
 * an object with `command` and optional `mount` / `name`. Anything else
 * THROWS, naming the phase and the index: a repository that meant to
 * declare a check and got the shape wrong must find out, not be silently
 * ungraded.
 *
 * `spec` absent, `spec.tasks` absent, or both arrays absent is an empty
 * set and NOT an error — a repository that declares nothing declares
 * nothing, which is the state of every repository today.
 *
 * `kind` is the Work's kind. `'app'` reads the App spec's `spec.checks`
 * (see the module header) and declares no setup phase — the App spec has
 * no `tasks` block. Every other kind, and no kind at all, reads
 * `spec.tasks` exactly as before.
 */
export function parseRepoDeclaredCommands(
    spec: unknown,
    kind?: string | null,
): RepoDeclaredCommandSet {
    if (spec === undefined || spec === null) return { setup: [], checks: [] };
    if (typeof spec !== 'object' || Array.isArray(spec)) {
        throw new RepoDeclaredCommandsError('.works/works.yml `spec` must be a mapping');
    }
    if (kind === 'app') {
        return { setup: [], checks: parseAppSpecChecks((spec as Record<string, unknown>).checks) };
    }
    const tasks = (spec as Record<string, unknown>).tasks;
    if (tasks === undefined || tasks === null) return { setup: [], checks: [] };
    if (typeof tasks !== 'object' || Array.isArray(tasks)) {
        throw new RepoDeclaredCommandsError('.works/works.yml `spec.tasks` must be a mapping');
    }
    const source = tasks as Record<string, unknown>;
    return {
        setup: parsePhase(source.setup, 'setup'),
        checks: parsePhase(source.checks, 'checks'),
    };
}

/**
 * Per-phase ceilings. The setup phase's is the NODE'S ceiling
 * (`FLEET_AGENT_TASK_MAX_SETUP_STEPS`), not the generic declaration cap,
 * and it is the same number the works.yml schema enforces (`REPO_SETUP_MAX`).
 *
 * Why it matters that these agree: a 9-to-20-entry setup phase used to be
 * admitted here, allow-listed, sealed into the immutable job payload and
 * enqueued — and then refused by `normalizeAgentTaskSetup` on the node,
 * AFTER a worktree had been provisioned, with a message about a payload
 * ceiling. The failure belongs at plan time, naming `.works/works.yml`,
 * which is the file somebody has to edit.
 */
const PHASE_MAX: Readonly<Record<'setup' | 'checks', number>> = {
    setup: FLEET_AGENT_TASK_MAX_SETUP_STEPS,
    checks: REPO_DECLARED_COMMANDS_MAX,
};

function parsePhase(raw: unknown, phase: 'setup' | 'checks'): RepoDeclaredCommand[] {
    if (raw === undefined || raw === null) return [];
    const at = `spec.tasks.${phase}`;
    if (!Array.isArray(raw)) {
        throw new RepoDeclaredCommandsError(`${at} must be a list of commands`);
    }
    const max = PHASE_MAX[phase];
    if (raw.length > max) {
        throw new RepoDeclaredCommandsError(
            `${at} declares ${raw.length} commands; the ceiling is ${max}`,
        );
    }
    return raw.map((entry, index) => parseEntry(entry, `${at}[${index}]`));
}

function parseEntry(entry: unknown, at: string): RepoDeclaredCommand {
    if (typeof entry === 'string') {
        return { command: requireCommand(entry, at) };
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new RepoDeclaredCommandsError(
            `${at} must be a command string or a mapping with a 'command' key`,
        );
    }
    const source = entry as Record<string, unknown>;
    const out: RepoDeclaredCommand = { command: requireCommand(source.command, `${at}.command`) };

    if (source.mount !== undefined && source.mount !== null) {
        if (typeof source.mount !== 'string' || !source.mount.trim()) {
            throw new RepoDeclaredCommandsError(
                `${at}.mount must be the name of a mounted repository`,
            );
        }
        out.mountDir = source.mount.trim();
    }
    if (source.name !== undefined && source.name !== null) {
        if (typeof source.name !== 'string') {
            throw new RepoDeclaredCommandsError(`${at}.name must be a non-empty label`);
        }
        // The one field here that decides nothing — and therefore the one
        // an attacker would use to say something. It is rendered into the
        // `# ACCEPTANCE CHECKS` section of the instructions a model CLI
        // with write access to the repository reads, so it is SANITIZED,
        // not merely capped: terminal escapes and C0 control characters
        // come out (the planner strips chat-template turn markers on top
        // of this), the rest is trimmed and truncated. An empty result is
        // refused rather than silently replaced by the command.
        const label = sanitizeLabel(source.name);
        if (!label) {
            throw new RepoDeclaredCommandsError(`${at}.name must be a non-empty label`);
        }
        out.name = label;
    }
    return out;
}

/** ANSI CSI sequences (`ESC [ … m` and friends) pasted into a label. */
const ANSI_CSI_SEQUENCE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
/** C0 control characters (TAB / LF / CR included — a label is one line) and DEL. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;

function sanitizeLabel(value: string): string {
    return value
        .replace(ANSI_CSI_SEQUENCE, '')
        .replace(CONTROL_CHARACTERS, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, NAME_MAX_LENGTH)
        .trim();
}

function requireCommand(value: unknown, at: string): string {
    const normalized = normalizeRepoDeclaredCommand(value);
    if (!normalized) {
        throw new RepoDeclaredCommandsError(
            `${at} must be a non-empty command with no control characters, at most 500 characters long`,
        );
    }
    return normalized;
}

/**
 * How many App spec checks one run reads (APW-08 T13). The same number as
 * `AppWorkRulesService`'s `MAX_CHECKS` and the CI matrix's ceiling (plan
 * §9.1); declared here rather than imported so this file stays free of the
 * `app-works/` import graph (the require ring `app-work-change-gate.port.ts`
 * documents).
 */
export const APP_SPEC_CHECKS_MAX = 20;

/** APW-03 `schema.md` §17 — `timeoutSeconds` bounds and default. */
const APP_CHECK_TIMEOUT_MIN_SECONDS = 60;
const APP_CHECK_TIMEOUT_MAX_SECONDS = 7200;
const APP_CHECK_TIMEOUT_DEFAULT_SECONDS = 1800;

/**
 * APW-08 T13 — `spec.checks[]` of an App spec, strictly.
 *
 * Same refusal posture as `spec.tasks`: a malformed entry THROWS naming
 * its index, because a member who meant to declare a check and got the
 * shape wrong must find out rather than be silently ungraded. APW-03's
 * validator has normally refused such a spec long before a run plans, so
 * reaching a throw here means the effective spec and the file disagree.
 *
 * Entries past {@link APP_SPEC_CHECKS_MAX} are IGNORED (truncated from the
 * front, as the run's rules are), never refused: a spec with 30 checks is
 * not invalid, it just cannot run all 30 on every Task.
 *
 * Keys other than the four the App spec defines are not read — the
 * schema's `unknown_field` and `x-*` rules are APW-03's business.
 */
function parseAppSpecChecks(raw: unknown): RepoDeclaredCommand[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
        throw new RepoDeclaredCommandsError('spec.checks must be a list of checks');
    }
    return raw
        .slice(0, APP_SPEC_CHECKS_MAX)
        .map((entry, index) => parseAppSpecCheck(entry, `spec.checks[${index}]`));
}

function parseAppSpecCheck(entry: unknown, at: string): RepoDeclaredCommand {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new RepoDeclaredCommandsError(
            `${at} must be a mapping with 'name' and 'command' keys`,
        );
    }
    const source = entry as Record<string, unknown>;
    const command = requireCommand(source.command, `${at}.command`);
    // The App spec REQUIRES a name (it is what `Ever Works check: {name}`
    // reports under), and it is rendered into the model's instructions like
    // any other label, so it is sanitized exactly as `spec.tasks` names are.
    const name = typeof source.name === 'string' ? sanitizeLabel(source.name) : '';
    if (!name) {
        throw new RepoDeclaredCommandsError(`${at}.name must be a non-empty label`);
    }
    const out: RepoDeclaredCommand = { command, name };

    if (source.required !== undefined && source.required !== null) {
        if (typeof source.required !== 'boolean') {
            throw new RepoDeclaredCommandsError(`${at}.required must be true or false`);
        }
        out.required = source.required;
    } else {
        out.required = true;
    }

    if (source.timeoutSeconds !== undefined && source.timeoutSeconds !== null) {
        const seconds = source.timeoutSeconds;
        if (
            typeof seconds !== 'number' ||
            !Number.isInteger(seconds) ||
            seconds < APP_CHECK_TIMEOUT_MIN_SECONDS ||
            seconds > APP_CHECK_TIMEOUT_MAX_SECONDS
        ) {
            throw new RepoDeclaredCommandsError(
                `${at}.timeoutSeconds must be a whole number of seconds from ` +
                    `${APP_CHECK_TIMEOUT_MIN_SECONDS} to ${APP_CHECK_TIMEOUT_MAX_SECONDS}`,
            );
        }
        out.timeoutSec = seconds;
    } else {
        out.timeoutSec = APP_CHECK_TIMEOUT_DEFAULT_SECONDS;
    }
    return out;
}

/** Everything the admission gate needs to decide, in one argument. */
export interface RepoDeclaredCommandAdmission {
    /** What the repository asked for, already shape-validated. */
    declared: RepoDeclaredCommandSet;
    /** The Work owner's decision. `off` admits nothing. */
    policy: WorkRepoDeclaredCommandPolicy;
    /** `mountDir` of every repository this run actually provisions. */
    mountDirs: readonly string[];
    /** Where the declarations came from, for the refusal message. */
    repositoryId?: string;
    /**
     * APW-08 T13 — the Work's kind. `'app'` reports a command the
     * allow-list does not admit as {@link RepoDeclaredCommandAdmissionResult.notAdmitted}
     * instead of refusing the run; every other kind refuses exactly as before.
     */
    kind?: string | null;
}

/**
 * APW-08 T13 (FR-14) — one App spec check the owner has not admitted for
 * their machines. It never executes; it is carried to the gate so the gate
 * is never green because of it.
 */
export interface NotAdmittedCheck {
    /** `repo/check-N` — the position-derived id it WOULD have run under. */
    id: string;
    /** The App spec `name`. */
    name: string;
    /** The command the owner would have to admit, verbatim (normalized). */
    command: string;
    /** A required one keeps the gate from grading green. */
    required: boolean;
}

/**
 * What the gate returns. `notAdmitted` is present ONLY for an App Work
 * (`kind: 'app'`): every other kind's result is the exact two-key shape it
 * always was, so a repository Work's planned payload cannot change shape
 * because this epic exists.
 */
export interface RepoDeclaredCommandAdmissionResult {
    setup: TaskAcceptanceCheck[];
    checks: TaskAcceptanceCheck[];
    notAdmitted?: NotAdmittedCheck[];
}

/**
 * Turn a repository's declarations into frozen checks, or REFUSE.
 *
 * Three ways this refuses, and each one is a case where running anyway
 * would report a verdict that is not true:
 *
 *  - **the command is not on the allow-list.** Dropping it would produce a
 *    run the repository believes was verified and was not. Refusing tells
 *    the owner exactly which line to add to Work settings — or which line
 *    somebody added to their repository.
 *  - **`mount:` names a repository this run does not provision.** The
 *    same string is refused a second time on the node, against the
 *    descriptor the provisioner actually returned; this earlier check
 *    exists so the failure lands at plan time with a message about
 *    configuration rather than at run time with a message about a path.
 *  - **the policy is `off`.** Then nothing is admitted at all — but the
 *    caller is expected not to have READ the file in that case, so
 *    reaching here with declarations and `off` is a caller bug, and it is
 *    treated as a refusal rather than as an empty result.
 *
 * For an App Work (`kind: 'app'`, APW-08 T13) the FIRST of those is not a
 * refusal: the check is returned under `notAdmitted` and never executes
 * (FR-14). The other two still refuse — they are configuration faults,
 * not an owner's decision still to be made.
 */
export function admitRepoDeclaredCommands(
    input: RepoDeclaredCommandAdmission,
): RepoDeclaredCommandAdmissionResult {
    const { declared, policy, mountDirs } = input;
    const where = input.repositoryId ? ` in ${input.repositoryId}` : '';
    const total = declared.setup.length + declared.checks.length;
    if (total === 0) return { setup: [], checks: [] };
    const reportNotAdmitted = input.kind === 'app';
    const notAdmitted: NotAdmittedCheck[] = [];

    if (policy.mode !== 'allowlist') {
        throw new RepoDeclaredCommandsError(
            `.works/works.yml${where} declares ${total} command(s) but this Work does not read repository-declared ` +
                `commands. Turn them on in Work settings and allow-list each command, or remove them from the file.`,
        );
    }

    // Case-insensitive, matching every other mountDir comparison in the
    // fleet: the nodes run on case-insensitive file systems.
    const provisioned = new Set(mountDirs.map((dir) => dir.toLowerCase()));

    const admit = (
        commands: readonly RepoDeclaredCommand[],
        phase: TaskCheckPhase,
    ): TaskAcceptanceCheck[] =>
        commands.flatMap((declaredCommand, index): TaskAcceptanceCheck[] => {
            const id = repoDeclaredCommandId(phase === 'setup' ? 'setup' : 'check', index);
            if (!isRepoDeclaredCommandAllowed(declaredCommand.command, policy)) {
                if (reportNotAdmitted) {
                    // APW-08 T13 — the id is still the POSITION's, so a
                    // check keeps one id whether or not it is admitted,
                    // and admitting it later does not renumber the rest.
                    notAdmitted.push({
                        id,
                        name: declaredCommand.name ?? declaredCommand.command,
                        command: declaredCommand.command,
                        required: declaredCommand.required !== false,
                    });
                    return [];
                }
                throw new RepoDeclaredCommandsError(
                    `.works/works.yml${where} declares the ${phase} command '${declaredCommand.command}', which is ` +
                        `not on this Work's allow-list. A declared command is a command this Work's machines will ` +
                        `run: add it verbatim in Work settings to allow it.`,
                );
            }
            if (
                declaredCommand.mountDir &&
                !provisioned.has(declaredCommand.mountDir.toLowerCase())
            ) {
                throw new RepoDeclaredCommandsError(
                    `.works/works.yml${where} declares a ${phase} command in repository ` +
                        `'${declaredCommand.mountDir}', which this Task does not mount` +
                        (provisioned.size > 0
                            ? ` (mounted: ${mountDirs.join(', ')})`
                            : ' (this Task mounts none)'),
                );
            }
            const check: TaskAcceptanceCheck = {
                id,
                name: declaredCommand.name ?? declaredCommand.command,
                kind: 'custom',
                command: declaredCommand.command,
                // A repository that declares a check is asking for it to be
                // enforced. There is no way to declare an advisory one in
                // `spec.tasks`; only an App spec check carries `required`
                // (APW-08 T13), and only its own value is honoured.
                required: declaredCommand.required !== false,
                phase,
            };
            if (declaredCommand.mountDir) check.mountDir = declaredCommand.mountDir;
            if (declaredCommand.timeoutSec !== undefined) {
                check.timeoutSec = declaredCommand.timeoutSec;
            }
            return [check];
        });

    const result: RepoDeclaredCommandAdmissionResult = {
        setup: admit(declared.setup, 'setup'),
        checks: admit(declared.checks, 'check'),
    };
    if (reportNotAdmitted) result.notAdmitted = notAdmitted;
    return result;
}

/**
 * APW-08 T13 — the run-report row for a check the owner has not admitted:
 * never executed, so no exit code and no duration, and not green.
 */
export function notAdmittedCheckResult(check: Pick<NotAdmittedCheck, 'id'>): TaskCheckResult {
    return { id: check.id, exitCode: null, status: 'not-admitted', durationMs: 0 };
}

/**
 * APW-08 T13 (FR-14, ACC-08-10) — carry the not-admitted checks into the
 * gate a run reports.
 *
 * The verdict a Fleet node reports is computed over the checks it RAN, and
 * a not-admitted check is never sent to it — so a run whose only admitted
 * check passed comes back `green` while a required check was never
 * executed. This is the correction, applied on the platform when the result
 * is read:
 *
 *  - every not-admitted check is appended to `checks` as a `not-admitted`
 *    row, so the run report names it (the S16 copy) instead of omitting it;
 *  - a `green` gate with at least one REQUIRED not-admitted check becomes
 *    `red` — the node's own rule ("a required check that is not green reds
 *    the gate") applied to the checks it never saw.
 *
 * Every other gate is left as reported: `none` and `skipped` are already
 * not green, and `none` after a blocked setup must keep saying "never ran"
 * rather than claim a check failed. A not-admitted ADVISORY check is
 * reported and changes nothing (FR-16). With nothing not-admitted the input
 * comes back unchanged — the same object, so every other Work kind's result
 * is untouched.
 */
export function foldNotAdmittedChecks<
    T extends { gateStatus?: GateStatus | string | null; checks?: unknown[] | null },
>(
    result: T,
    notAdmitted: readonly Pick<NotAdmittedCheck, 'id' | 'required'>[] | null | undefined,
): T {
    if (!notAdmitted || notAdmitted.length === 0) return result;
    const known = new Set(
        (result.checks ?? [])
            .map((check) => (check as { id?: unknown } | null)?.id)
            .filter((id): id is string => typeof id === 'string'),
    );
    // A result row with the same id wins: it means the node DID run a check
    // under that id, and a report must never contradict what executed.
    const missing = notAdmitted.filter((check) => !known.has(check.id));
    if (missing.length === 0) return result;
    const blocksGreen = missing.some((check) => check.required !== false);
    // The cast is the generic's: the two keys written are the two `T`
    // constrains, with values of the shapes it constrains them to.
    return {
        ...result,
        checks: [...(result.checks ?? []), ...missing.map(notAdmittedCheckResult)],
        gateStatus: result.gateStatus === 'green' && blocksGreen ? 'red' : result.gateStatus,
    } as T;
}
