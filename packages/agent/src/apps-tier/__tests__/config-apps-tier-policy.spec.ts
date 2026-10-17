/**
 * APW-10's minimal `AppsTierPolicy` (`../config-apps-tier-policy.ts`). These cases moved here, body
 * unchanged, from `app-runtime/__tests__/app-runtime-worker.adapters.spec.ts` together with the
 * class (Resolution R-5: nothing under `app-runtime/` reads the managed-tier ceiling).
 *
 * Hand-written fakes only: no database, cluster, network or clock.
 */

import { Logger } from '@nestjs/common';

import * as workerContext from '../../app-runtime/worker-context';
import { APPS_MANAGED_ENABLED_ENV, ConfigAppsTierPolicy } from '../config-apps-tier-policy';

beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

describe('ConfigAppsTierPolicy (APPS_TIER_POLICY, minimal APW-10)', () => {
    it('is closed by default and answers exactly like the disabled policy', async () => {
        const policy = new ConfigAppsTierPolicy({});

        expect(policy.isOpen()).toBe(false);
        expect(policy.managedScope()).toBe('verified-blueprints');
        expect(policy.podPolicy().runtimeClassName).toBeNull();
        await expect(policy.eligibility('u-1')).resolves.toEqual({
            eligible: false,
            reasons: ['managedTierDisabled'],
        });
        await expect(policy.resolveClusterCredential('w-1')).rejects.toMatchObject({
            code: 'cluster_credential_unavailable',
        });
        expect(() => policy.ingress()).toThrow();
    });

    it('opens only with EVER_WORKS_APPS_MANAGED_ENABLED=true and reads its policy from env', async () => {
        // The credential is read only inside the isolated worker (APW-10 lite).
        const spy = jest.spyOn(workerContext, 'isAppClusterWorkerContext').mockReturnValue(true);
        const policy = new ConfigAppsTierPolicy({
            [APPS_MANAGED_ENABLED_ENV]: 'true',
            EVER_WORKS_APPS_MANAGED_KUBECONFIG: 'apiVersion: v1',
            EVER_WORKS_APPS_MANAGED_RUNTIME_CLASS: 'gvisor',
        });

        expect(policy.isOpen()).toBe(true);
        expect(policy.podPolicy().runtimeClassName).toBe('gvisor');
        expect(policy.ingress()).toEqual({
            className: 'nginx',
            controllerNamespace: 'ingress-nginx',
            edgeTlsMode: 'edge',
        });
        await expect(policy.resolveClusterCredential('w-1')).resolves.toBe('apiVersion: v1');
        await expect(policy.eligibility('u-1')).resolves.toEqual({ eligible: true, reasons: [] });
        spy.mockRestore();
    });

    it('APW-10 lite: never reads the kubeconfig outside the isolated worker', async () => {
        const spy = jest.spyOn(workerContext, 'isAppClusterWorkerContext').mockReturnValue(false);
        const policy = new ConfigAppsTierPolicy({
            [APPS_MANAGED_ENABLED_ENV]: 'true',
            EVER_WORKS_APPS_MANAGED_KUBECONFIG: 'apiVersion: v1',
        });
        await expect(policy.resolveClusterCredential('w-1')).rejects.toMatchObject({
            code: 'cluster_credential_unavailable',
        });
        spy.mockRestore();
    });

    it('APW-10 lite: decodes a base64 kubeconfig, defaults the scope to any, and takes quota overrides', async () => {
        const spy = jest.spyOn(workerContext, 'isAppClusterWorkerContext').mockReturnValue(true);
        const yaml = ['apiVersion: v1', 'kind: Config', 'clusters: []', ''].join('\n');
        const policy = new ConfigAppsTierPolicy({
            [APPS_MANAGED_ENABLED_ENV]: 'true',
            EVER_WORKS_APPS_MANAGED_KUBECONFIG: Buffer.from(yaml).toString('base64'),
            EVER_WORKS_APPS_MANAGED_QUOTA_CPU_LIMITS: '8',
            EVER_WORKS_APPS_MANAGED_QUOTA_PODS: '40',
            EVER_WORKS_APPS_MANAGED_QUOTA_MEMORY_LIMITS: 'lots',
            EVER_WORKS_APPS_MANAGED_LIMIT_MAX_MEMORY: '8Gi',
        });
        await expect(policy.resolveClusterCredential('w-1')).resolves.toBe(yaml.trim());
        expect(policy.managedScope()).toBe('any');
        const pod = policy.podPolicy();
        expect(pod.quota).toMatchObject({ 'limits.cpu': '8', pods: 40, 'limits.memory': '10Gi' });
        expect(pod.limitRange.max).toMatchObject({ memory: '8Gi', cpu: '2' });
        expect(
            new ConfigAppsTierPolicy({
                [APPS_MANAGED_ENABLED_ENV]: 'true',
                EVER_WORKS_APPS_MANAGED_SCOPE: 'verified-blueprints',
            }).managedScope(),
        ).toBe('verified-blueprints');
        await expect(
            new ConfigAppsTierPolicy({
                [APPS_MANAGED_ENABLED_ENV]: 'true',
                EVER_WORKS_APPS_MANAGED_KUBECONFIG: 'bm90IGEga3ViZWNvbmZpZw==',
            }).resolveClusterCredential('w-1'),
        ).rejects.toMatchObject({ code: 'cluster_credential_unavailable' });
        spy.mockRestore();
    });

    it('refuses an open tier with no credential instead of handing out an empty one', async () => {
        jest.spyOn(workerContext, 'isAppClusterWorkerContext').mockReturnValueOnce(true);
        const policy = new ConfigAppsTierPolicy({ [APPS_MANAGED_ENABLED_ENV]: 'true' });
        await expect(policy.resolveClusterCredential('w-1')).rejects.toMatchObject({
            code: 'cluster_credential_unavailable',
        });
    });
});
