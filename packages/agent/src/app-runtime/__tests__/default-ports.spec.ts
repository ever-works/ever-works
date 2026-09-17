/**
 * APW-06 T3 — the fail-closed App runtime defaults, and the one rule this folder exists to enforce.
 *
 * Every assertion here is one of the task's own acceptance points (`APW-06-app-runtime/tasks.md`
 * lines 80–90): the tier policy is never open, each unavailable source names its exact code, the
 * runtime target's `prepareDependencyTarget` *resolves* while its siblings throw, the verification
 * sink refuses before a namespace could exist, and nothing under this folder learns whether the
 * managed tier is open from the environment (R-5, `CONTRACTS.md` §0:48).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    DisabledAppsTierPolicy,
    UnavailablePullCredentialSource,
    UnavailableRuntimeEnvSource,
    UnavailableRuntimeTarget,
    UnavailableVerificationSink,
} from '../default-ports';
import { AppPortUnavailableError, type AppVerificationUpdate } from '../ports';

/** Runs `operation` and returns the machine-readable code of the error it threw. */
async function codeOf(operation: () => Promise<unknown>): Promise<string> {
    try {
        await operation();
    } catch (error) {
        expect(error).toBeInstanceOf(AppPortUnavailableError);
        return (error as AppPortUnavailableError).code;
    }
    throw new Error('Expected the call to refuse, but it resolved.');
}

describe('DisabledAppsTierPolicy (APW-10/plan.md §5.5:704–721, R-5)', () => {
    it('is closed', () => {
        expect(new DisabledAppsTierPolicy().isOpen()).toBe(false);
    });

    it('never reports open, whatever the call order', async () => {
        const policy = new DisabledAppsTierPolicy();

        for (let i = 0; i < 25; i += 1) {
            expect(policy.isOpen()).toBe(false);
        }

        // Every other member, in several orders: a thrown refusal must not flip the answer, and a
        // resolved one must not either. Each call is wrapped so a synchronous throw (the two
        // state-less refusals) is observed the same way as a rejected promise.
        const calls: Array<() => Promise<unknown>> = [
            () => policy.eligibility('user-1'),
            () => policy.resolveClusterCredential('work-1'),
            async () => policy.managedScope(),
            async () => policy.podPolicy(),
            async () => policy.ingress(),
        ];

        for (const call of [...calls, ...[...calls].reverse()]) {
            await call().catch(() => undefined);
            expect(policy.isOpen()).toBe(false);
        }

        expect(policy.isOpen()).toBe(false);
    });

    it('never widens its scope while it is closed', () => {
        expect(new DisabledAppsTierPolicy().managedScope()).toBe('verified-blueprints');
    });

    it('reports nobody eligible, with the closed managed-hosting reason', async () => {
        await expect(new DisabledAppsTierPolicy().eligibility('user-1')).resolves.toEqual({
            eligible: false,
            reasons: ['managedTierDisabled'],
        });
    });

    it('answers podPolicy() with the fail-closed state, never an exception', () => {
        const policy = new DisabledAppsTierPolicy();

        // §5.1:684 reads `podPolicy().runtimeClassName` to build `managed_sandbox_unavailable`
        // (R-24), and §5.1's service "never throws for an unmet one" — so this call must answer.
        const podPolicy = policy.podPolicy();
        expect(podPolicy.runtimeClassName).toBeNull();

        // plan §4.2:437–440 — the thirteen documented `ResourceQuota` defaults.
        expect(podPolicy.quota).toEqual({
            'requests.cpu': '2',
            'limits.cpu': '4',
            'requests.memory': '4Gi',
            'limits.memory': '6Gi',
            pods: 20,
            persistentvolumeclaims: 5,
            'requests.storage': '20Gi',
            'services.loadbalancers': 0,
            'services.nodeports': 0,
            'count/jobs.batch': 20,
            'count/cronjobs.batch': 20,
            secrets: 30,
            configmaps: 30,
        });

        // plan §4.2:435–436 with the `ever-works-apps` per-container `max`.
        expect(podPolicy.limitRange).toEqual({
            defaultRequest: { cpu: '100m', memory: '128Mi' },
            defaultLimit: { cpu: '1', memory: '512Mi', ephemeralStorage: '1Gi' },
            max: { cpu: '2', memory: '4Gi' },
        });
    });

    it('refuses to hand out a control-namespace credential or an ingress', async () => {
        const policy = new DisabledAppsTierPolicy();

        await expect(policy.resolveClusterCredential('work-1')).rejects.toBeInstanceOf(
            AppPortUnavailableError,
        );
        expect(await codeOf(() => policy.resolveClusterCredential('work-1'))).toBe(
            'cluster_credential_unavailable',
        );
        expect(await codeOf(async () => policy.ingress())).toBe('tier_ingress_unavailable');
    });
});

describe('Unavailable* sources refuse with their exact code (plan §5.1:690, §4.12:659)', () => {
    it('UnavailablePullCredentialSource refuses with pull_credential_unavailable', async () => {
        const source = new UnavailablePullCredentialSource();

        await expect(source.resolve('work-1', 'build-1')).rejects.toBeInstanceOf(
            AppPortUnavailableError,
        );
        expect(await codeOf(() => source.resolve('work-1', 'build-1'))).toBe(
            'pull_credential_unavailable',
        );
    });

    it('UnavailableRuntimeEnvSource refuses with env_source_unavailable on both paths', async () => {
        const source = new UnavailableRuntimeEnvSource();
        const ctx = {
            target: 'cluster' as const,
            primaryUrl: null,
            primaryHost: null,
            buildCommitSha: null,
            internalUrls: {},
        };

        await expect(
            source.resolve('work-1', 'sha-1', {
                target: 'your-cluster',
                primaryUrl: null,
                primaryHost: null,
                buildCommitSha: null,
                internalUrls: {},
            }),
        ).rejects.toBeInstanceOf(AppPortUnavailableError);
        expect(
            await codeOf(() =>
                source.resolve('work-1', 'sha-1', {
                    target: 'your-cluster',
                    primaryUrl: null,
                    primaryHost: null,
                    buildCommitSha: null,
                    internalUrls: {},
                }),
            ),
        ).toBe('env_source_unavailable');

        await expect(source.resolveEphemeral('work-1', 'sha-1', ctx)).rejects.toBeInstanceOf(
            AppPortUnavailableError,
        );
        expect(await codeOf(() => source.resolveEphemeral('work-1', 'sha-1', ctx))).toBe(
            'env_source_unavailable',
        );
    });

    it('UnavailableVerificationSink refuses with verification_sink_unavailable', async () => {
        const sink = new UnavailableVerificationSink();

        await expect(sink.report(verificationUpdate('never-created-ns'))).rejects.toBeInstanceOf(
            AppPortUnavailableError,
        );
        expect(await codeOf(() => sink.report(verificationUpdate('never-created-ns')))).toBe(
            'verification_sink_unavailable',
        );
    });
});

describe('the deliberate asymmetry (plan §9.6:1429–1436, §9.9:1559–1562)', () => {
    it('UnavailableRuntimeTarget.prepareDependencyTarget RESOLVES { unavailable: target_none }', async () => {
        const target = new UnavailableRuntimeTarget();

        await expect(target.prepareDependencyTarget('work-1')).resolves.toEqual({
            unavailable: 'target_none',
        });

        // …and it does not throw: the same call, observed as a value rather than as a settlement.
        let threw = false;
        let resolved: unknown;
        try {
            resolved = await target.prepareDependencyTarget('work-1');
        } catch {
            threw = true;
        }
        expect(threw).toBe(false);
        expect(resolved).toEqual({ unavailable: 'target_none' });
    });

    it('is the only member that resolves: its siblings throw', async () => {
        await expect(
            new UnavailableRuntimeTarget().prepareDependencyTarget('work-1'),
        ).resolves.toBeDefined();
        await expect(new UnavailablePullCredentialSource().resolve('w', 'b')).rejects.toThrow(
            AppPortUnavailableError,
        );
        await expect(
            new UnavailableRuntimeEnvSource().resolveEphemeral('w', 's', {
                target: 'runner',
                primaryUrl: null,
                primaryHost: null,
                buildCommitSha: null,
                internalUrls: {},
            }),
        ).rejects.toThrow(AppPortUnavailableError);
        await expect(
            new UnavailableVerificationSink().report(verificationUpdate('ns')),
        ).rejects.toThrow(AppPortUnavailableError);
        await expect(new DisabledAppsTierPolicy().resolveClusterCredential('w')).rejects.toThrow(
            AppPortUnavailableError,
        );
    });

    it('keeps target_none as the default and accepts the other §9.6 reasons', async () => {
        await expect(
            new UnavailableRuntimeTarget().prepareDependencyTarget('work-1'),
        ).resolves.toEqual({
            unavailable: 'target_none',
        });
        await expect(
            new UnavailableRuntimeTarget('cluster_unreachable').prepareDependencyTarget('work-1'),
        ).resolves.toEqual({ unavailable: 'cluster_unreachable' });
    });
});

describe('the verification sink refuses before any namespace exists (plan §4.12:656–661)', () => {
    it('refuses a first report, for a namespace that was never created', async () => {
        const sink = new UnavailableVerificationSink();
        const update = verificationUpdate('ew-verification-never-created');

        // No prior call, no namespace creation, no cluster contact: the refusal is the whole body.
        await expect(sink.report(update)).rejects.toThrow(AppPortUnavailableError);
        expect(await codeOf(() => sink.report(update))).toBe('verification_sink_unavailable');
    });

    it('refuses on every phase the verification flow reports', async () => {
        const sink = new UnavailableVerificationSink();

        for (const phase of ['cluster-check', 'prepare', 'rollout', 'destroy'] as const) {
            const update: AppVerificationUpdate = {
                ...verificationUpdate('ew-verification-never-created'),
                phase,
            };
            expect(await codeOf(() => sink.report(update))).toBe('verification_sink_unavailable');
        }
    });

    it('refuses the unavailable state APW-04 falls back on', async () => {
        const sink = new UnavailableVerificationSink();
        const update = verificationUpdate('ew-verification-never-created');
        update.state = 'unavailable';

        expect(await codeOf(() => sink.report(update))).toBe('verification_sink_unavailable');
    });
});

describe('R-5: nothing under packages/agent/src/app-runtime reads the tier ceiling', () => {
    const folder = path.resolve(__dirname, '..');
    const forbidden = ['EVER', 'WORKS', 'APPS', 'MANAGED', 'ENABLED'].join('_');

    /** Every regular file under this folder, itself included. */
    function ownFiles(dir: string): string[] {
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) return ownFiles(full);
            return entry.isFile() ? [full] : [];
        });
    }

    it('has no mention of the managed-tier ceiling environment variable', () => {
        const files = ownFiles(folder);
        const names = files.map((file) => path.relative(folder, file));

        // A guard against a vacuous scan: the files that exist today are really being read.
        expect(names).toEqual(
            expect.arrayContaining([
                'index.ts',
                'ports.ts',
                'default-ports.ts',
                path.join('__tests__', 'default-ports.spec.ts'),
            ]),
        );

        const contents = files.map((file) => fs.readFileSync(file, 'utf8'));

        // Known-good control: the scan reads real content, so a zero below is not a broken reader.
        expect(contents.some((content) => content.includes('AppPortUnavailableError'))).toBe(true);

        const offenders = names.filter((name, index) => contents[index].includes(forbidden));
        expect(offenders).toEqual([]);
    });
});

/** A plausible verification update — what APW-04's flow would report for an attempt. */
function verificationUpdate(namespace: string): AppVerificationUpdate {
    return {
        provisioningId: 'provisioning-1',
        attempt: 1,
        namespace,
        expiresAt: new Date(0).toISOString(),
        state: 'running',
        phase: 'prepare',
        components: [],
        jobs: [],
        smoke: null,
    };
}
