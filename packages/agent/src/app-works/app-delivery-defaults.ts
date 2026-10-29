import { Logger } from '@nestjs/common';
import { APP_FOLLOW_UPS_OPEN_PER_WORK_MAX, APP_FOLLOW_UPS_PER_CHANGE_MAX } from '@ever-works/contracts';

/**
 * APW-08 — the delivery chain's **owner-decision defaults** (APW08-G25, spec §9's five
 * `[NEEDS CLARIFICATION]` markers). The spec records a default for each and P1 builds on it; the
 * owner has not confirmed them yet. Every default the delivery chain itself decides is read from
 * an environment variable here, so the owner's answer is a configuration change, not a code
 * change. **Default per APW08-G25 — the owner may change it.**
 *
 * | Register | Question | Default (spec) | Where it is decided | Switch |
 * |---|---|---|---|---|
 * | `CL-33` / `CL-08-1` | Does **Live with warnings** close the Task? | yes — closed, a manual fix Task offered (FR-40) | `decideDelivery` | `EVER_WORKS_APP_DELIVERY_LIVE_WITH_WARNINGS_CLOSES` (default `true`) |
 * | `CL-37` / `CL-08-5` | Follow-up budget | 2 automatic follow-ups per merged change (FR-37) | `DeliveryFollowUpService` | `EVER_WORKS_APP_FOLLOW_UPS_PER_CHANGE` (default `2`, 0–5) |
 * | `CL-37` / `CL-08-5` | Follow-up budget | 3 open automatic follow-ups per App Work (FR-38) | `DeliveryFollowUpService` | `EVER_WORKS_APP_FOLLOW_UPS_OPEN_PER_WORK` (default `3`, 0–10) |
 * | `CL-34` / `CL-08-2` | Protect every file under `.github/workflows/`? | yes, blanket | the change guard (`ALWAYS_PROTECTED`) **and** the platform-wide `agent-protected-repo-paths.ts` | none here — see below |
 * | `CL-35` / `CL-08-3` | CI checks and "a red check opens no pull request" | cloud runs open the PR, the gate governs merge-readiness | checks admission (T11–T16, another lane) | none here |
 * | `CL-36` / `CL-08-4` | Default change Agent | FR-42's resolution rule (resolved by R-21) | `AppWorkAgentResolver` (already built) | none — the resolution rule IS the default |
 *
 * `CL-34` has no switch on purpose: `.github/workflows/**` is also refused by the platform-wide
 * repository-path policy every agent commit passes (`policy/agent-protected-repo-paths.ts`), so an
 * App Works-only switch could not loosen it and would only mislead an operator. The spec records
 * an App spec opt-out as a future **addition**. `CL-35` belongs to the checks-admission lane.
 *
 * Values are read at each decision, never cached at boot, exactly like `app-work-switches.ts`.
 * An unrecognised value falls back to the spec default (logged once per value): these are
 * policy numbers, not kill switches, so the safe reading is the documented default.
 *
 * 🛑 A leaf file: the Nest logger and contracts only, so every caller can import it.
 */

export const APP_DELIVERY_DEFAULTS_ENV = Object.freeze({
    /** `CL-08-1` — `false` treats Live with warnings as a failed delivery (follow-up opened). */
    liveWithWarningsCloses: 'EVER_WORKS_APP_DELIVERY_LIVE_WITH_WARNINGS_CLOSES',
    /** `CL-08-5` — automatic follow-ups per merged change, counted along the chain (FR-37). */
    followUpsPerChange: 'EVER_WORKS_APP_FOLLOW_UPS_PER_CHANGE',
    /** `CL-08-5` — open automatic follow-ups per App Work (FR-38). */
    followUpsOpenPerWork: 'EVER_WORKS_APP_FOLLOW_UPS_OPEN_PER_WORK',
} as const);

/** The spec defaults (APW08-G25), in one place. */
export const APP_DELIVERY_DEFAULT_VALUES = Object.freeze({
    liveWithWarningsCloses: true,
    followUpsPerChange: APP_FOLLOW_UPS_PER_CHANGE_MAX,
    followUpsOpenPerWork: APP_FOLLOW_UPS_OPEN_PER_WORK_MAX,
});

/** The bounds an operator may set the two counters to. */
export const APP_FOLLOW_UPS_PER_CHANGE_RANGE = Object.freeze({ min: 0, max: 5 });
export const APP_FOLLOW_UPS_OPEN_PER_WORK_RANGE = Object.freeze({ min: 0, max: 10 });

export interface AppDeliveryDefaults {
    liveWithWarningsCloses: boolean;
    followUpsPerChange: number;
    followUpsOpenPerWork: number;
}

type EnvLike = Readonly<Record<string, string | undefined>>;

const logger = new Logger('AppDeliveryDefaults');
const warnedValues = new Set<string>();

function warnOnce(name: string, value: string, fallback: unknown): void {
    const key = `${name}=${value}`;
    if (warnedValues.has(key)) return;
    warnedValues.add(key);
    logger.warn(
        `${name} has a value this platform does not recognise; using the APW08-G25 default (${String(fallback)}).`,
    );
}

function readBoolean(name: string, fallback: boolean, env: EnvLike): boolean {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = raw.trim().toLowerCase();
    if (value.length === 0) return fallback;
    if (['true', '1', 'on', 'yes'].includes(value)) return true;
    if (['false', '0', 'off', 'no'].includes(value)) return false;
    warnOnce(name, value, fallback);
    return fallback;
}

function readInteger(
    name: string,
    fallback: number,
    range: { min: number; max: number },
    env: EnvLike,
): number {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = raw.trim();
    if (value.length === 0) return fallback;
    if (!/^\d{1,2}$/.test(value)) {
        warnOnce(name, value, fallback);
        return fallback;
    }
    const parsed = Number(value);
    if (parsed < range.min || parsed > range.max) {
        warnOnce(name, value, fallback);
        return fallback;
    }
    return parsed;
}

/** The three APW08-G25 delivery defaults, read now. */
export function readAppDeliveryDefaults(env: EnvLike = process.env): AppDeliveryDefaults {
    return {
        liveWithWarningsCloses: readBoolean(
            APP_DELIVERY_DEFAULTS_ENV.liveWithWarningsCloses,
            APP_DELIVERY_DEFAULT_VALUES.liveWithWarningsCloses,
            env,
        ),
        followUpsPerChange: readInteger(
            APP_DELIVERY_DEFAULTS_ENV.followUpsPerChange,
            APP_DELIVERY_DEFAULT_VALUES.followUpsPerChange,
            APP_FOLLOW_UPS_PER_CHANGE_RANGE,
            env,
        ),
        followUpsOpenPerWork: readInteger(
            APP_DELIVERY_DEFAULTS_ENV.followUpsOpenPerWork,
            APP_DELIVERY_DEFAULT_VALUES.followUpsOpenPerWork,
            APP_FOLLOW_UPS_OPEN_PER_WORK_RANGE,
            env,
        ),
    };
}
