/**
 * Unit spec for the read-only Kubernetes assertions (APW-13 T10).
 *
 * Both refusals T10 requires are exercised here, and neither test touches a
 * cluster: every `kubectl` call goes through the module's injectable runner,
 * which this spec stubs (`tasks.md:158-161`).
 *
 *   - **`Secret.data` is never read.** `secretKeys` maps a Secret to its key
 *     names and the asserted result must not contain the encoded values;
 *     `assertNoSecretValues` throws for a caller-supplied Secret object that
 *     still carries them.
 *   - **Deletion is allow-listed twice over.** `deleteTestNamespace` refuses
 *     outside the `apw-e2e-` prefix, outside the context allow-list, and when
 *     no context is allow-listed at all — in every refusal the runner records
 *     no removal call, which is the ACC-13-17 namespace half (`spec.md:551`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as k8s from '../k8s-assert';

interface StubResult {
    stdout?: string;
    stderr?: string;
    code?: number;
}

/**
 * Install a runner stub and return the argument list of every call it saw, so
 * a refusal can be asserted as "the removal never reached kubectl".
 */
function stubRunner(handler: (args: string[]) => StubResult): string[][] {
    const calls: string[][] = [];
    k8s.setKubectlRunner(async (args) => {
        calls.push(args);
        const result = handler(args);
        return {
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            code: result.code ?? 0,
        };
    });
    return calls;
}

const SECRET_JSON = JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'apw-e2e-app-env', namespace: 'apw-e2e-abc' },
    type: 'Opaque',
    data: {
        DATABASE_URL: 'cG9zdGdyZXM6Ly91c2VyOnBhc3NAZGIvYXBw',
        SESSION_SECRET: 'aG9uZXl0b2tlbi12YWx1ZQ==',
    },
});

beforeEach(() => {
    vi.unstubAllEnvs();
});

afterEach(() => {
    k8s.setKubectlRunner(undefined);
    vi.unstubAllEnvs();
});

describe('k8s-assert: a Secret is read as key names and nothing else (ACC-13-17)', () => {
    it('returns the key names of a Secret without any value', async () => {
        stubRunner(() => ({ stdout: SECRET_JSON }));
        const result = await k8s.secretKeys({ name: 'apw-e2e-app-env', namespace: 'apw-e2e-abc' });
        expect(result.keys).toEqual(['DATABASE_URL', 'SESSION_SECRET']);
        expect(JSON.stringify(result)).not.toContain('cG9zdGdyZXM6Ly91c2VyOnBhc3NAZGIvYXBw');
        expect(JSON.stringify(result)).not.toContain('aG9uZXl0b2tlbi12YWx1ZQ==');
    });

    it('asks kubectl for the object as JSON in the named namespace', async () => {
        const calls = stubRunner(() => ({ stdout: SECRET_JSON }));
        await k8s.secretKeys({ name: 'apw-e2e-app-env', namespace: 'apw-e2e-abc' });
        expect(calls[0]).toEqual([
            'get',
            'secret',
            'apw-e2e-app-env',
            '-n',
            'apw-e2e-abc',
            '-o',
            'json',
        ]);
    });

    it('refuses a Secret object that carries values', () => {
        expect(() =>
            k8s.assertNoSecretValues({
                metadata: { name: 'apw-e2e-app-env' },
                data: { SESSION_SECRET: 'aG9uZXl0b2tlbi12YWx1ZQ==' },
            }),
        ).toThrow(/refusing to read Secret\.data/);
    });

    it('refuses stringData as well, and accepts a key-only object', () => {
        expect(() =>
            k8s.assertNoSecretValues({ metadata: { name: 's' }, stringData: { TOKEN: 'value' } }),
        ).toThrow(/refusing to read Secret\.stringData/);
        expect(k8s.assertNoSecretValues({ metadata: { name: 's' }, data: {} })).toEqual([]);
    });
});

describe('k8s-assert: deletion is allow-listed twice over (ACC-13-17)', () => {
    it('refuses a namespace outside the apw-e2e- prefix', async () => {
        vi.stubEnv('APW_E2E_USER_CLUSTER_CONTEXT', 'apw-e2e-user');
        const calls = stubRunner(() => ({}));
        await expect(
            k8s.deleteTestNamespace('default', { context: 'apw-e2e-user' }),
        ).rejects.toThrow(/must start with "apw-e2e-"/);
        expect(calls).toEqual([]);
    });

    it('refuses the prefix without its trailing dash', async () => {
        vi.stubEnv('APW_E2E_USER_CLUSTER_CONTEXT', 'apw-e2e-user');
        const calls = stubRunner(() => ({}));
        await expect(k8s.deleteTestNamespace('apw-e2e')).rejects.toThrow(
            /must start with "apw-e2e-"/,
        );
        expect(calls).toEqual([]);
    });

    it('refuses a context outside the allow-list', async () => {
        vi.stubEnv('APW_E2E_USER_CLUSTER_CONTEXT', 'apw-e2e-user');
        vi.stubEnv('APW_E2E_APPS_TIER_CONTEXT', 'apw-e2e-apps');
        const calls = stubRunner(() => ({}));
        await expect(
            k8s.deleteTestNamespace('apw-e2e-abc', { context: 'kind-ever-works' }),
        ).rejects.toThrow(/kube context "kind-ever-works" is not allow-listed/);
        expect(calls).toEqual([]);
    });

    it('refuses every deletion when no context is allow-listed', async () => {
        // Pinned empty rather than merely unset: the assertion only means
        // something if both variables are known to hold nothing.
        vi.stubEnv('APW_E2E_USER_CLUSTER_CONTEXT', '');
        vi.stubEnv('APW_E2E_APPS_TIER_CONTEXT', '');
        const calls = stubRunner((args) => (args[0] === 'config' ? { stdout: 'ever-k8s\n' } : {}));
        await expect(k8s.deleteTestNamespace('apw-e2e-abc')).rejects.toThrow(/is not allow-listed/);
        expect(calls).toEqual([['config', 'current-context']]);
    });

    it('removes an apw-e2e- namespace in an allow-listed context', async () => {
        vi.stubEnv('APW_E2E_USER_CLUSTER_CONTEXT', 'apw-e2e-user');
        const calls = stubRunner((args) =>
            args[0] === 'config'
                ? { stdout: 'apw-e2e-user\n' }
                : { stdout: 'namespace "apw-e2e-abc" deleted\n' },
        );
        const result = await k8s.deleteTestNamespace('apw-e2e-abc');
        expect(result.namespace).toBe('apw-e2e-abc');
        expect(result.context).toBe('apw-e2e-user');
        expect(calls).toEqual([
            ['config', 'current-context'],
            ['--context', 'apw-e2e-user', 'delete', 'namespace', 'apw-e2e-abc', '--wait=false'],
        ]);
    });
});

describe('k8s-assert: read-only queries by App Work label', () => {
    it('selects objects with the App Work label and maps their refs', async () => {
        const calls = stubRunner(() => ({
            stdout: JSON.stringify({
                items: [
                    {
                        kind: 'Ingress',
                        metadata: {
                            name: 'apw-e2e-abc',
                            namespace: 'apw-e2e-abc',
                            creationTimestamp: '2026-09-17T10:00:00Z',
                            labels: { 'ever-works.io/part-of': 'apw-e2e-abc' },
                        },
                    },
                ],
            }),
        }));
        const objects = await k8s.listObjectsByWorkLabel({
            kind: 'ingress',
            workSlug: 'apw-e2e-abc',
            namespace: 'apw-e2e-abc',
        });
        expect(calls[0]).toEqual([
            'get',
            'ingress',
            '-l',
            'ever-works.io/part-of=apw-e2e-abc',
            '-n',
            'apw-e2e-abc',
            '-o',
            'json',
        ]);
        expect(objects).toEqual([
            {
                kind: 'Ingress',
                name: 'apw-e2e-abc',
                namespace: 'apw-e2e-abc',
                createdAt: '2026-09-17T10:00:00Z',
                labels: { 'ever-works.io/part-of': 'apw-e2e-abc' },
            },
        ]);
    });

    it('reports the Ingress creation time, and null when there is none', async () => {
        stubRunner(() => ({
            stdout: JSON.stringify({
                items: [
                    {
                        metadata: {
                            name: 'i',
                            namespace: 'n',
                            creationTimestamp: '2026-09-17T10:00:00Z',
                        },
                    },
                ],
            }),
        }));
        expect(
            await k8s.getIngressCreatedAt({ workSlug: 'apw-e2e-abc', namespace: 'apw-e2e-abc' }),
        ).toBe('2026-09-17T10:00:00Z');

        stubRunner(() => ({ stdout: JSON.stringify({ items: [] }) }));
        expect(
            await k8s.getIngressCreatedAt({ workSlug: 'apw-e2e-abc', namespace: 'apw-e2e-abc' }),
        ).toBeNull();
    });

    it('reads a Job completion time, and null while it has not completed', async () => {
        stubRunner(() => ({
            stdout: JSON.stringify({ status: { completionTime: '2026-09-17T10:05:00Z' } }),
        }));
        expect(
            await k8s.getJobCompletedAt({
                name: 'apw-e2e-abc-first-deploy',
                namespace: 'apw-e2e-abc',
            }),
        ).toBe('2026-09-17T10:05:00Z');

        stubRunner(() => ({ stdout: JSON.stringify({ status: { active: 1 } }) }));
        expect(
            await k8s.getJobCompletedAt({
                name: 'apw-e2e-abc-first-deploy',
                namespace: 'apw-e2e-abc',
            }),
        ).toBeNull();
    });

    it('lists CronJobs with their schedule and suspension state', async () => {
        stubRunner(() => ({
            stdout: JSON.stringify({
                items: [
                    {
                        metadata: { name: 'tick', namespace: 'apw-e2e-abc' },
                        spec: { schedule: '*/2 * * * *', suspend: false },
                        status: { lastScheduleTime: '2026-09-17T10:04:00Z' },
                    },
                    {
                        metadata: { name: 'tick-managed', namespace: 'apw-e2e-abc' },
                        spec: { schedule: '*/5 * * * *', suspend: true },
                    },
                ],
            }),
        }));
        expect(await k8s.listCronJobs({ workSlug: 'apw-e2e-abc' })).toEqual([
            {
                name: 'tick',
                namespace: 'apw-e2e-abc',
                schedule: '*/2 * * * *',
                suspend: false,
                lastScheduleTime: '2026-09-17T10:04:00Z',
            },
            {
                name: 'tick-managed',
                namespace: 'apw-e2e-abc',
                schedule: '*/5 * * * *',
                suspend: true,
                lastScheduleTime: null,
            },
        ]);
    });

    it('needs a work label or a namespace, and throws kubectl failures', async () => {
        stubRunner(() => ({ stdout: '{}' }));
        await expect(k8s.listCronJobs()).rejects.toThrow(/pass `workSlug`/);

        stubRunner(() => ({ stderr: 'Error from server (NotFound)', code: 1 }));
        await expect(
            k8s.getJobCompletedAt({ name: 'missing', namespace: 'apw-e2e-abc' }),
        ).rejects.toThrow(/get job missing failed \(exit 1\): Error from server \(NotFound\)/);
    });
});
