import {
    FLEET_AGENT_TASK_MAX_SETUP_STEPS,
    isRepoDeclaredCommandAllowed,
    normalizeRepoDeclaredCommand,
    repoDeclaredCommandId,
    REPO_DECLARED_COMMANDS_MAX,
    type TaskAcceptanceCheck,
    type TaskCheckPhase,
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
 */
export function parseRepoDeclaredCommands(spec: unknown): RepoDeclaredCommandSet {
    if (spec === undefined || spec === null) return { setup: [], checks: [] };
    if (typeof spec !== 'object' || Array.isArray(spec)) {
        throw new RepoDeclaredCommandsError('.works/works.yml `spec` must be a mapping');
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
 */
export function admitRepoDeclaredCommands(input: RepoDeclaredCommandAdmission): {
    setup: TaskAcceptanceCheck[];
    checks: TaskAcceptanceCheck[];
} {
    const { declared, policy, mountDirs } = input;
    const where = input.repositoryId ? ` in ${input.repositoryId}` : '';
    const total = declared.setup.length + declared.checks.length;
    if (total === 0) return { setup: [], checks: [] };

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
        commands.map((declaredCommand, index) => {
            if (!isRepoDeclaredCommandAllowed(declaredCommand.command, policy)) {
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
                id: repoDeclaredCommandId(phase === 'setup' ? 'setup' : 'check', index),
                name: declaredCommand.name ?? declaredCommand.command,
                kind: 'custom',
                command: declaredCommand.command,
                // A repository that declares a check is asking for it to be
                // enforced. There is no way to declare an advisory one.
                required: true,
                phase,
            };
            if (declaredCommand.mountDir) check.mountDir = declaredCommand.mountDir;
            return check;
        });

    return { setup: admit(declared.setup, 'setup'), checks: admit(declared.checks, 'check') };
}
