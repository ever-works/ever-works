/**
 * APW-05 T28 / T46 (lane aw-builds-bindings, 2026-10-27) — the Build settings dialog's data.
 *
 * The settings are the build plugin's own Work-scoped settings, written through the existing
 * `PATCH /api/works/:workId/plugins/:pluginId/settings` with the plugin id taken from the Builds
 * list response's `provider` (plan §5: "the web never embeds a plugin id"). The API validates
 * every value against the plugin's schema again; the checks here only give the member the
 * field-level message before a round trip.
 *
 * The keys are the plugin schema's (plan §4.4, §4.7b). The pull token is NOT here: it has its
 * own write-only form and route (§4.12).
 */

/** The seven settings the dialog edits, in plan §4.4's order and then §4.7b's two. */
export const APP_BUILD_SETTINGS_KEYS = [
    'largerRunnerLabel',
    'largerRunnerMemoryGiB',
    'largerRunnerVcpu',
    'reclaimDisk',
    'attestations',
    'allowBuildValuesOnPullRequests',
    'verificationPromptedValuesRequireApproval',
] as const;

export type AppBuildSettingsKey = (typeof APP_BUILD_SETTINGS_KEYS)[number];

export interface AppBuildSettings {
    /** `''` = no larger runner. */
    largerRunnerLabel: string;
    /** `null` when no larger runner is configured. */
    largerRunnerMemoryGiB: number | null;
    largerRunnerVcpu: number | null;
    reclaimDisk: boolean;
    attestations: boolean;
    allowBuildValuesOnPullRequests: boolean;
    verificationPromptedValuesRequireApproval: boolean;
}

/** The plugin schema's defaults (an absent key reads as these). */
export const APP_BUILD_SETTINGS_DEFAULTS: AppBuildSettings = {
    largerRunnerLabel: '',
    largerRunnerMemoryGiB: null,
    largerRunnerVcpu: null,
    reclaimDisk: true,
    attestations: false,
    allowBuildValuesOnPullRequests: false,
    verificationPromptedValuesRequireApproval: true,
};

/** The schema's bounds (plan §4.4), mirrored for the field messages only. */
export const APP_BUILD_SETTINGS_LIMITS = {
    labelPattern: /^[A-Za-z0-9._-]{1,64}$/,
    memoryMinGiB: 8,
    memoryMaxGiB: 256,
    vcpuMin: 2,
    vcpuMax: 64,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * The settings a Work-plugin row answers, as the dialog's values: the Work's own value, else the
 * person's default (`largerRunner*` and `reclaimDisk` may carry one, plan §4.4), else the schema
 * default. A `0` memory or vCPU is the schema's "no larger runner" and reads as `null`.
 */
export function normalizeAppBuildSettings(
    workSettings: unknown,
    userSettings?: unknown,
): AppBuildSettings {
    const work = isRecord(workSettings) ? workSettings : {};
    const user = isRecord(userSettings) ? userSettings : {};
    const pick = (key: AppBuildSettingsKey): unknown => (key in work ? work[key] : user[key]);
    const bool = (key: AppBuildSettingsKey, fallback: boolean): boolean => {
        const value = pick(key);
        return typeof value === 'boolean' ? value : fallback;
    };
    const label = pick('largerRunnerLabel');
    return {
        largerRunnerLabel: typeof label === 'string' ? label.trim() : '',
        largerRunnerMemoryGiB: positiveInteger(pick('largerRunnerMemoryGiB')),
        largerRunnerVcpu: positiveInteger(pick('largerRunnerVcpu')),
        reclaimDisk: bool('reclaimDisk', APP_BUILD_SETTINGS_DEFAULTS.reclaimDisk),
        attestations: bool('attestations', APP_BUILD_SETTINGS_DEFAULTS.attestations),
        allowBuildValuesOnPullRequests: bool(
            'allowBuildValuesOnPullRequests',
            APP_BUILD_SETTINGS_DEFAULTS.allowBuildValuesOnPullRequests,
        ),
        verificationPromptedValuesRequireApproval: bool(
            'verificationPromptedValuesRequireApproval',
            APP_BUILD_SETTINGS_DEFAULTS.verificationPromptedValuesRequireApproval,
        ),
    };
}

/** The dialog's field-level problems; each is an i18n leaf under `builds.settings.errors`. */
export type AppBuildSettingsError = 'labelInvalid' | 'memoryRequired' | 'memoryRange' | 'vcpuRange';

/**
 * The `settings` body for the PATCH, or the first field problem.
 *
 * - No label clears all three runner keys with `null` (the API deletes a key sent as `null`):
 *   the schema's "no larger runner" is the ABSENCE of the keys, and a `0` memory would fail the
 *   schema's minimum.
 * - A label needs a memory (the schema's `allOf`: "the memory check cannot run without it");
 *   vCPU is optional and informational.
 * - `attestations` is sent only for a public repository: on a private one the plugin ignores it,
 *   and the dialog does not show it, so a stored value is left as it was.
 * - `verificationPromptedValuesRequireApproval` is never sent (see the body).
 */
export function appBuildSettingsPatch(
    values: AppBuildSettings,
    options: { readonly publicRepository: boolean },
): { ok: true; settings: Record<string, unknown> } | { ok: false; error: AppBuildSettingsError } {
    const label = values.largerRunnerLabel.trim();
    // `verificationPromptedValuesRequireApproval` is read but NOT written: the approval gate it
    // switches (T46's `startVerification` half) is not built yet, so offering the switch would
    // promise a protection that does not exist. A stored value is left exactly as it was.
    const settings: Record<string, unknown> = {
        reclaimDisk: values.reclaimDisk,
        allowBuildValuesOnPullRequests: values.allowBuildValuesOnPullRequests,
    };
    if (options.publicRepository) {
        settings.attestations = values.attestations;
    }

    if (label === '') {
        settings.largerRunnerLabel = null;
        settings.largerRunnerMemoryGiB = null;
        settings.largerRunnerVcpu = null;
        return { ok: true, settings };
    }

    if (!APP_BUILD_SETTINGS_LIMITS.labelPattern.test(label)) {
        return { ok: false, error: 'labelInvalid' };
    }
    const memory = values.largerRunnerMemoryGiB;
    if (memory === null) {
        return { ok: false, error: 'memoryRequired' };
    }
    if (
        !Number.isInteger(memory) ||
        memory < APP_BUILD_SETTINGS_LIMITS.memoryMinGiB ||
        memory > APP_BUILD_SETTINGS_LIMITS.memoryMaxGiB
    ) {
        return { ok: false, error: 'memoryRange' };
    }
    const vcpu = values.largerRunnerVcpu;
    if (
        vcpu !== null &&
        (!Number.isInteger(vcpu) ||
            vcpu < APP_BUILD_SETTINGS_LIMITS.vcpuMin ||
            vcpu > APP_BUILD_SETTINGS_LIMITS.vcpuMax)
    ) {
        return { ok: false, error: 'vcpuRange' };
    }

    settings.largerRunnerLabel = label;
    settings.largerRunnerMemoryGiB = memory;
    settings.largerRunnerVcpu = vcpu;
    return { ok: true, settings };
}
