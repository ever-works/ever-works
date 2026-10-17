import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import superjson from 'superjson';
import {
    APP_COMMIT_ANCESTRY,
    APP_DEPLOY_DEPLOYMENT_STORE,
    APP_DEPLOY_DISPATCHER,
    APP_IMAGE_PULL_CREDENTIAL_SOURCE,
    APP_IMAGE_REFERENCE_RESOLVER,
    APP_RUNTIME_ENV_SOURCE,
    APP_RUNTIME_EVENT_SINK,
    APP_RUNTIME_NOTIFICATIONS,
    APP_RUNTIME_TARGET,
    APP_UPSTREAM_STATE_READER,
    APPS_TIER_POLICY,
    AppDeployOrchestrator,
    AppDeployPreconditionsService,
    AppPublicSmokeService,
    AppRenderInputBuilder,
    AppBuildPullCredentialSource,
    AppRuntimeTargetAdapter,
    ConfigAppsTierPolicy,
    RegistryAppImageReferenceResolver,
    isAppClusterWorkerContext,
} from '@ever-works/agent/app-runtime';
import { WORK_APP_RUNTIME_STATES } from '@ever-works/agent/app-launcher';
import { APP_DEPENDENCIES_SERVICE } from '@ever-works/agent/app-runtime';
import { AppDependenciesService } from '@ever-works/agent/app-dependencies';
import { WorkRepository } from '@ever-works/agent/database';
import { TriggerAppRuntimeModule } from '../trigger-app-runtime.module';

/**
 * A0.7 (2026-10-17, lane aw-deploy) — **a dequeued Deployment reaches `READY` inside the isolated
 * worker**, with every collaborator but the cluster the one `TriggerAppRuntimeModule` binds.
 *
 * The module is booted for real against a loopback stub of the internal API (the same harness
 * as `trigger-app-runtime.module.spec.ts`). The orchestrator is then assembled from the
 * context's OWN providers — the preconditions pass (decision B1), the render-input builder, the
 * proxied runtime-state row, the env source, the Deployment store with `update`, the event relay
 * — and only the two things that would dial the outside world are fakes: the cluster access
 * (a fake App deployment plugin) and the registry lookup. What crosses the internal channel is
 * recorded and asserted, so this is the closest a unit suite gets to "the Deploy button works".
 */

interface RecordedRemoteCall {
    name: string;
    method: string;
    args: unknown[];
}

const WORK = {
    id: 'work-1',
    kind: 'app',
    slug: 'acme-app',
    userId: 'user-1',
    deployProvider: 'k8s',
    gitProvider: 'github',
};

const STATE = {
    workId: 'work-1',
    target: 'your-cluster',
    deployLockId: 'dep-1',
    clusterCheck: { fingerprint: 'fp-1', code: null },
    clusterFingerprint: null,
    targetSettings: { tls: 'none' },
    paused: false,
};

const SPEC = {
    status: 'valid',
    commitSha: 'c0ffee',
    spec: {
        build: { strategy: 'image', image: 'nginx:1.27' },
        components: [{ name: 'web', role: 'web', port: 8080 }],
    },
};

const ENV = {
    values: { NODE_ENV: 'production' },
    secretNames: [],
    unsetRequired: [],
    notReadyDependencies: [],
    egress: [],
};

describe('TriggerAppRuntimeModule — a Deployment end to end (A0.7)', () => {
    let context: INestApplicationContext;
    let stubApi: Server;
    const remoteCalls: RecordedRemoteCall[] = [];
    const remoteAnswers = new Map<string, unknown>([
        ['WorkAppRuntimeStateRepository.getOrCreate', STATE],
        ['WorkAppRuntimeStateRepository.patchRuntimeState', null],
        ['WorkAppRuntimeStateRepository.releaseDeployLock', true],
        ['WorkAppRuntimeStateRepository.takeQueued', null],
        ['AppSpecService.getEffectiveSpec', SPEC],
        ['AppEnvRuntimeSource.resolve', ENV],
        ['WorkRepository.findById', WORK],
        ['WorkCustomDomainRepository.findByWork', []],
        [
            'WorkDeploymentRepository.findById',
            { id: 'dep-1', workId: 'work-1', appRender: { preconditions: [] } },
        ],
        ['WorkDeploymentRepository.update', null],
        ['AppRuntimeEventRelayService.emit', null],
        ['WorkUpstreamStateRepository.findByWorkId', null],
    ]);

    beforeAll(async () => {
        stubApi = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', (chunk: Buffer) => chunks.push(chunk));
            request.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (request.url?.endsWith('/remote/call') && raw) {
                    const body = JSON.parse(raw) as {
                        name: string;
                        method: string;
                        args: { json: unknown; meta?: unknown };
                    };
                    remoteCalls.push({
                        name: body.name,
                        method: body.method,
                        args: superjson.deserialize(body.args as never) as unknown[],
                    });
                    const key = `${body.name}.${body.method}`;
                    if (remoteAnswers.has(key)) {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({ result: superjson.serialize(remoteAnswers.get(key)) }),
                        );
                        return;
                    }
                }
                response.writeHead(501, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'the stub answers nothing' }));
            });
        });
        await new Promise<void>((resolve) => stubApi.listen(0, '127.0.0.1', () => resolve()));
        const port = (stubApi.address() as { port: number }).port;

        process.env.TRIGGER_INTERNAL_API_URL = `http://127.0.0.1:${port}`;
        process.env.TRIGGER_INTERNAL_SECRET = 'a07-spec-secret';

        context = await NestFactory.createApplicationContext(TriggerAppRuntimeModule, {
            abortOnError: false,
            logger: false,
        });
    }, 180_000);

    afterAll(async () => {
        await context?.close();
        await new Promise<void>((resolve) => stubApi?.close(() => resolve()));
    });

    const get = <T>(token: unknown): T => context.get(token as never, { strict: false }) as T;

    it('binds the A0.7 ports to real implementations, not the fail-closed defaults', () => {
        expect(get(APPS_TIER_POLICY)).toBeInstanceOf(ConfigAppsTierPolicy);
        expect(get(APP_IMAGE_PULL_CREDENTIAL_SOURCE)).toBeInstanceOf(AppBuildPullCredentialSource);
        expect(get(APP_RUNTIME_TARGET)).toBeInstanceOf(AppRuntimeTargetAdapter);
        expect(get(APP_IMAGE_REFERENCE_RESOLVER)).toBeInstanceOf(RegistryAppImageReferenceResolver);
        // Lane aw-deploy-3: APW-07's service is composed here, so readiness is enforced, not warned.
        expect(get(APP_DEPENDENCIES_SERVICE)).toBeInstanceOf(AppDependenciesService);
        for (const token of [
            WORK_APP_RUNTIME_STATES,
            APP_RUNTIME_ENV_SOURCE,
            APP_RUNTIME_EVENT_SINK,
            APP_RUNTIME_NOTIFICATIONS,
            APP_UPSTREAM_STATE_READER,
            APP_COMMIT_ANCESTRY,
            APP_DEPLOY_DEPLOYMENT_STORE,
            APP_DEPLOY_DISPATCHER,
        ]) {
            expect(get(token)).toBeTruthy();
        }
    });

    it('hydrates the proxied Work into a real entity (getRepoOwner works across the hop)', async () => {
        // THIS module's provider (the one its local facade and services inject) — `strict: false`
        // could hand back an imported module's plain proxy instead.
        const works = context
            .select(TriggerAppRuntimeModule)
            .get(WorkRepository, { strict: true }) as WorkRepository;
        const work = (await works.findById('work-1')) as unknown as { getRepoOwner(): string };
        expect(typeof work.getRepoOwner).toBe('function');
        expect(work.getRepoOwner()).toBeTypeOf('string');
    });

    it('runs a dequeued published-image Deployment to READY — B1, spec, env, row, events, lock', async () => {
        expect(isAppClusterWorkerContext()).toBe(true);

        const deployApp = async () => ({
            outcome: 'succeeded',
            components: [{ name: 'web', ready: 1, desired: 1 }],
            jobs: [],
            smoke: null,
            warnings: [],
            ingressAddress: { ip: '203.0.113.10', hostname: null },
            firstDeployJobsCompleted: true,
            isolationEnforced: true,
        });
        const targets = {
            resolveClusterAccess: async () => ({
                outcome: 'access' as const,
                access: {
                    target: 'your-cluster' as const,
                    ref: {
                        workId: 'work-1',
                        namespace: 'ew-acme-app',
                        target: 'your-cluster' as const,
                        kubeContext: null,
                        clusterFingerprint: 'fp-1',
                    },
                    credential: 'kubeconfig-document',
                    pluginId: 'k8s',
                    plugin: { deployApp },
                },
            }),
        };
        const images = {
            resolve: async () => ({
                status: 'resolved' as const,
                reference: `nginx@sha256:${'d'.repeat(64)}`,
                digest: `sha256:${'d'.repeat(64)}`,
                resolvedFromTag: true,
            }),
        };

        const orchestrator = new AppDeployOrchestrator(
            get(AppDeployPreconditionsService),
            get(AppRenderInputBuilder),
            targets as never,
            get(APP_RUNTIME_EVENT_SINK),
            images,
            get(WORK_APP_RUNTIME_STATES),
            get(APP_DEPLOY_DEPLOYMENT_STORE),
            get(AppPublicSmokeService),
            get(APP_RUNTIME_NOTIFICATIONS),
            get(APP_UPSTREAM_STATE_READER),
            get(APP_COMMIT_ANCESTRY),
            undefined,
            get(APP_DEPLOY_DISPATCHER),
            undefined,
        );

        const before = remoteCalls.length;
        const result = await orchestrator.run({
            workId: 'work-1',
            deploymentId: 'dep-1',
            trigger: 'manual',
            buildId: null,
            specCommitSha: 'c0ffee',
            userId: 'user-1',
        });
        const calls = remoteCalls.slice(before);
        const called = (name: string, method: string) =>
            calls.filter((call) => call.name === name && call.method === method);

        expect({ state: result.state, code: result.code, reason: result.reason }).toEqual({
            state: 'READY',
            code: null,
            reason: null,
        });
        expect(result.lockReleased).toBe(true);

        // The row went DEPLOYING, then READY with the pinned image recorded (§5.8).
        const updates = called('WorkDeploymentRepository', 'update').map(
            (call) => call.args[1] as Record<string, unknown>,
        );
        expect(updates.map((fields) => fields.state).filter(Boolean)).toEqual([
            'DEPLOYING',
            'READY',
        ]);
        expect((updates.at(-1)?.appRender as { image?: { digest?: string } }).image?.digest).toBe(
            `sha256:${'d'.repeat(64)}`,
        );

        // The env came from the API's env source, at the spec commit.
        expect(called('AppEnvRuntimeSource', 'resolve')[0]?.args.slice(0, 2)).toEqual([
            'work-1',
            'c0ffee',
        ]);

        // The runtime state recorded the live Deployment, and the lock was released by THIS one.
        expect(
            called('WorkAppRuntimeStateRepository', 'patchRuntimeState')[0]?.args[1],
        ).toMatchObject({
            currentDeploymentId: 'dep-1',
            clusterFingerprint: 'fp-1',
            namespace: 'ew-acme-app',
        });
        expect(called('WorkAppRuntimeStateRepository', 'releaseDeployLock')[0]?.args).toEqual([
            'work-1',
            'dep-1',
        ]);

        // §9.4's events, relayed to the API in order, names and ids only.
        const events = called('AppRuntimeEventRelayService', 'emit').map(
            (call) => (call.args[0] as { name: string }).name,
        );
        expect(events).toEqual(['app.deploy.started', 'app.deploy.succeeded', 'app.smoke.passed']);
    });

    it('refuses a dequeued Deployment that no longer holds the lock (B1) — nothing is deployed', async () => {
        remoteAnswers.set('WorkAppRuntimeStateRepository.getOrCreate', {
            ...STATE,
            deployLockId: 'dep-other',
        });
        let deployed = 0;
        const orchestrator = new AppDeployOrchestrator(
            get(AppDeployPreconditionsService),
            get(AppRenderInputBuilder),
            {
                resolveClusterAccess: async () => {
                    deployed += 1;
                    return { outcome: 'refused' as const, refusal: 'unexpected' };
                },
            } as never,
        );

        const result = await orchestrator.run({ workId: 'work-1', deploymentId: 'dep-1' });

        expect(result.state).toBe('ERROR');
        expect(result.code).toBe('worker_not_isolated');
        expect(deployed).toBe(0);
        remoteAnswers.set('WorkAppRuntimeStateRepository.getOrCreate', STATE);
    });
});
