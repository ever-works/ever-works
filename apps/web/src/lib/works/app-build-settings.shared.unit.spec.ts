import { describe, expect, it } from 'vitest';
import {
    APP_BUILD_SETTINGS_DEFAULTS,
    appBuildSettingsPatch,
    normalizeAppBuildSettings,
} from './app-build-settings.shared';

/** APW-05 T28 / T46 — the Build settings dialog's read and write rules. */
describe('normalizeAppBuildSettings', () => {
    it('answers the schema defaults for a Work with nothing stored', () => {
        expect(normalizeAppBuildSettings(undefined)).toEqual(APP_BUILD_SETTINGS_DEFAULTS);
        expect(APP_BUILD_SETTINGS_DEFAULTS.allowBuildValuesOnPullRequests).toBe(false);
        expect(APP_BUILD_SETTINGS_DEFAULTS.verificationPromptedValuesRequireApproval).toBe(true);
    });

    it('prefers the Work value over the person’s default, and reads 0 as "no larger runner"', () => {
        expect(
            normalizeAppBuildSettings(
                { reclaimDisk: false, largerRunnerMemoryGiB: 0 },
                { reclaimDisk: true, largerRunnerLabel: 'big-runner', largerRunnerMemoryGiB: 32 },
            ),
        ).toMatchObject({
            reclaimDisk: false,
            largerRunnerLabel: 'big-runner',
            largerRunnerMemoryGiB: null,
        });
    });

    it('ignores a value of the wrong type rather than coercing it', () => {
        expect(
            normalizeAppBuildSettings({ allowBuildValuesOnPullRequests: 'yes', largerRunnerVcpu: -4 }),
        ).toMatchObject({ allowBuildValuesOnPullRequests: false, largerRunnerVcpu: null });
    });
});

describe('appBuildSettingsPatch', () => {
    const base = { ...APP_BUILD_SETTINGS_DEFAULTS };

    it('clears all three runner keys with null when no label is set', () => {
        const patch = appBuildSettingsPatch(
            { ...base, largerRunnerMemoryGiB: 64 },
            { publicRepository: false },
        );
        expect(patch).toEqual({
            ok: true,
            settings: {
                reclaimDisk: true,
                allowBuildValuesOnPullRequests: false,
                verificationPromptedValuesRequireApproval: true,
                largerRunnerLabel: null,
                largerRunnerMemoryGiB: null,
                largerRunnerVcpu: null,
            },
        });
    });

    it('sends attestations only for a public repository', () => {
        const priv = appBuildSettingsPatch({ ...base, attestations: true }, { publicRepository: false });
        const pub = appBuildSettingsPatch({ ...base, attestations: true }, { publicRepository: true });
        expect(priv.ok && 'attestations' in priv.settings).toBe(false);
        expect(pub.ok && pub.settings.attestations).toBe(true);
    });

    it('requires a memory with a label, inside the schema bounds', () => {
        expect(
            appBuildSettingsPatch({ ...base, largerRunnerLabel: 'big' }, { publicRepository: false }),
        ).toEqual({ ok: false, error: 'memoryRequired' });
        expect(
            appBuildSettingsPatch(
                { ...base, largerRunnerLabel: 'big', largerRunnerMemoryGiB: 4 },
                { publicRepository: false },
            ),
        ).toEqual({ ok: false, error: 'memoryRange' });
        expect(
            appBuildSettingsPatch(
                { ...base, largerRunnerLabel: 'big', largerRunnerMemoryGiB: 32, largerRunnerVcpu: 1 },
                { publicRepository: false },
            ),
        ).toEqual({ ok: false, error: 'vcpuRange' });
        expect(
            appBuildSettingsPatch(
                { ...base, largerRunnerLabel: 'big runner', largerRunnerMemoryGiB: 32 },
                { publicRepository: false },
            ),
        ).toEqual({ ok: false, error: 'labelInvalid' });
    });

    it('sends a valid larger runner as typed, vCPU optional', () => {
        const patch = appBuildSettingsPatch(
            { ...base, largerRunnerLabel: ' ubuntu-16core ', largerRunnerMemoryGiB: 64 },
            { publicRepository: false },
        );
        expect(patch.ok && patch.settings).toMatchObject({
            largerRunnerLabel: 'ubuntu-16core',
            largerRunnerMemoryGiB: 64,
            largerRunnerVcpu: null,
        });
    });

    it('never carries the pull token or any key outside the seven', () => {
        const patch = appBuildSettingsPatch(
            { ...base, pullToken: 'ghp_x' } as never,
            { publicRepository: true },
        );
        expect(patch.ok && Object.keys(patch.settings).sort()).toEqual(
            [
                'allowBuildValuesOnPullRequests',
                'attestations',
                'largerRunnerLabel',
                'largerRunnerMemoryGiB',
                'largerRunnerVcpu',
                'reclaimDisk',
                'verificationPromptedValuesRequireApproval',
            ].sort(),
        );
    });
});
