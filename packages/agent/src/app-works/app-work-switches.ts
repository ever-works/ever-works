import { Logger } from '@nestjs/common';

/**
 * APW-08 T49 (XC-10, FR-74, CONTRACTS R-30 / §7) — the evolve loop's two operator kill switches.
 *
 * | Switch | Unset | Off pauses |
 * |---|---|---|
 * | `EVER_WORKS_APP_CHANGES_ENABLED` | on | **new** App Work change runs, from every surface (chat, the board, a Goal, a Mission, a resumed or queued run) |
 * | `EVER_WORKS_APP_AUTO_DEPLOY_ENABLED` | on | the automatic Deployment of a deployable Build (a merge to the tracked branch → push Build → deploy), and APW-08 auto-delivery once it exists |
 *
 * **Default on** (CONTRACTS §7 lists both as `true`): the switches exist so an operator can stop
 * the feature in an incident, and the features already ship — adding a switch changes no
 * behaviour. **Fail closed** on a value this reader does not recognise: a switch someone set to
 * `flase` was meant to be off, so anything other than an empty value or a known spelling reads as
 * OFF, and the misspelling is logged once per value.
 *
 * Read at the moment of the decision, never cached at boot, so flipping the variable and rolling
 * the pods is enough — and each dispatcher reads it itself, so the switch bites for work created
 * before it was flipped (T49: "each reads the switch itself").
 *
 * **Nothing is deleted or hidden** (R-30): Tasks, boards, chains, Deployments and history stay
 * readable; a refused run leaves its Task where it was, to be run again once the switch is on.
 *
 * 🛑 A leaf file: the Nest logger only, so every dispatcher can import it without a cycle.
 */

export const APP_WORK_SWITCH_ENV = Object.freeze({
    /** New App Work change runs (APW-08). */
    changes: 'EVER_WORKS_APP_CHANGES_ENABLED',
    /** Automatic Deployments of a deployable Build (APW-06) and APW-08 auto-delivery. */
    autoDeploy: 'EVER_WORKS_APP_AUTO_DEPLOY_ENABLED',
} as const);

export type AppWorkSwitchName = (typeof APP_WORK_SWITCH_ENV)[keyof typeof APP_WORK_SWITCH_ENV];

/** CONTRACTS §8's program-wide refusal code for an R-30 switch that is off (HTTP 503). */
export const APP_WORK_SWITCH_OFF_CODE = 'switch_off';

const ON_VALUES = new Set(['true', '1', 'on', 'yes', 'enabled']);
const OFF_VALUES = new Set(['false', '0', 'off', 'no', 'disabled']);

const logger = new Logger('AppWorkSwitches');
const warnedValues = new Set<string>();

type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Whether one R-30 switch is on. Unset or blank → on (the default); a known "on" spelling → on;
 * a known "off" spelling → off; anything else → off (fail closed), logged once per value.
 */
export function readAppWorkSwitch(name: AppWorkSwitchName, env: EnvLike = process.env): boolean {
    const raw = env[name];
    if (raw === undefined) return true;
    const value = raw.trim().toLowerCase();
    if (value.length === 0) return true;
    if (ON_VALUES.has(value)) return true;
    if (OFF_VALUES.has(value)) return false;
    const key = `${name}=${value}`;
    if (!warnedValues.has(key)) {
        warnedValues.add(key);
        logger.warn(
            `${name} has a value this platform does not recognise; treating the switch as OFF (fail closed). ` +
                `Use true or false.`,
        );
    }
    return false;
}

export interface AppWorkSwitches {
    /** `EVER_WORKS_APP_CHANGES_ENABLED` — new App Work change runs may start. */
    changesEnabled: boolean;
    /** `EVER_WORKS_APP_AUTO_DEPLOY_ENABLED` — a deployable Build may deploy itself. */
    autoDeployEnabled: boolean;
}

/** Both APW-08 switches, read now. */
export function readAppWorkSwitches(env: EnvLike = process.env): AppWorkSwitches {
    return {
        changesEnabled: readAppWorkSwitch(APP_WORK_SWITCH_ENV.changes, env),
        autoDeployEnabled: readAppWorkSwitch(APP_WORK_SWITCH_ENV.autoDeploy, env),
    };
}

/** The member-facing copy for a paused change (plan §5.2 `appRules.changesPaused`). */
export const APP_CHANGES_PAUSED_MESSAGE =
    'Changes to apps are paused by the operator. Your Tasks and history are kept; try again once changes are resumed.';

/**
 * The run-row / dispatch reason for a change run the switch refused. Starts with the §8 code so a
 * reader (and a spec) can match it; names the switch, never anything else.
 */
export function describeAppChangesPaused(): string {
    return `${APP_WORK_SWITCH_OFF_CODE}: ${APP_WORK_SWITCH_ENV.changes} is off — ${APP_CHANGES_PAUSED_MESSAGE}`;
}
