import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { APP_WORKS_TELEMETRY_SINK } from '../../app-works/app-works-telemetry.service';
import { AppEnvActivityService } from '../../app-env/app-env.activity';
import { AppRuntimeTelemetryListener } from '../app-runtime.telemetry';

/**
 * APW-06 T55 and APW-07 T39 (lane aw-builds-bindings, 2026-10-27) — runtime, dependency and env
 * telemetry. The Done-when of both tasks: no payload carries a hostname, URL, namespace, env name
 * or value, bucket name, kubeconfig fragment or log text. Every case feeds a payload that DOES
 * carry such things and asserts only codes and counts reach the sink.
 */
type Sent = { distinctId: string; event: string; properties: Record<string, unknown> };

function sink(): { sent: Sent[]; track: (...args: unknown[]) => void } {
    const sent: Sent[] = [];
    return {
        sent,
        track: (distinctId: unknown, event: unknown, properties: unknown) =>
            sent.push({
                distinctId: String(distinctId),
                event: String(event),
                properties: properties as Record<string, unknown>,
            }),
    };
}

const FORBIDDEN = [
    'app.example.invalid',
    'https://',
    'ew-hello-1a2b',
    'DATABASE_URL',
    'postgres://user:pw@host/db',
    'attachments-bucket',
    'certificate-authority-data',
    'Error: connect ECONNREFUSED',
    'web',
    'migrate',
];

function expectClean(sent: readonly Sent[]): void {
    const text = JSON.stringify(sent.map((entry) => entry.properties));
    for (const value of FORBIDDEN) {
        expect(text).not.toContain(value);
    }
}

describe('AppRuntimeTelemetryListener (APW-06 T55)', () => {
    /** What a relayed deploy event looks like, plus everything a leak would add. */
    const base = {
        workId: 'w1',
        userId: 'owner-1',
        deploymentId: 'd1',
        buildId: 'b1',
        target: 'your-cluster',
        names: ['web', 'migrate'],
        host: 'app.example.invalid',
        url: 'https://app.example.invalid',
        namespace: 'ew-hello-1a2b',
    };

    it('reports a Deployment’s start and outcome with codes only', () => {
        const target = sink();
        const listener = new AppRuntimeTelemetryListener(target);

        listener.onDeployStarted(base);
        listener.onDeployFailed({ ...base, phase: 'apply', code: 'image_pull_failed' });
        listener.onDeployRolledBack({ ...base, phase: 'verify', code: 'smoke_failed' });
        listener.onDeploySucceeded({ ...base, phase: null, code: null });

        expect(target.sent.map((entry) => [entry.event, entry.properties])).toEqual([
            ['app_deploy_started', { target: 'your-cluster' }],
            [
                'app_deploy_outcome',
                {
                    outcome: 'failed',
                    target: 'your-cluster',
                    phase: 'apply',
                    code: 'image_pull_failed',
                },
            ],
            [
                'app_deploy_outcome',
                {
                    outcome: 'rolled_back',
                    target: 'your-cluster',
                    phase: 'verify',
                    code: 'smoke_failed',
                },
            ],
            [
                'app_deploy_outcome',
                { outcome: 'succeeded', target: 'your-cluster', phase: null, code: null },
            ],
        ]);
        expect(target.sent.every((entry) => entry.distinctId === 'owner-1')).toBe(true);
        expectClean(target.sent);
    });

    it('counts failed smoke checks and job outcomes without naming any', () => {
        const target = sink();
        const listener = new AppRuntimeTelemetryListener(target);

        listener.onSmokeFailed({ ...base });
        listener.onSmokePassed({ ...base, code: 'smoke_warnings' });
        listener.onJobFailed({ ...base, names: ['migrate'], code: 'failed' });

        expect(target.sent.map((entry) => [entry.event, entry.properties])).toEqual([
            ['app_smoke_outcome', { outcome: 'failed', classification: null, failedChecks: 2 }],
            [
                'app_smoke_outcome',
                { outcome: 'passed', classification: 'smoke_warnings', failedChecks: 2 },
            ],
            ['app_job_outcome', { outcome: 'failed' }],
        ]);
        expectClean(target.sent);
    });

    it('reports health transitions by code', () => {
        const target = sink();
        const listener = new AppRuntimeTelemetryListener(target);

        listener.onHealthDegraded({ ...base, code: 'public_check_failed' });
        listener.onHealthUnreachable({ ...base, code: 'cluster_unreachable' });
        listener.onHealthRecovered({ ...base, code: 'healthy' });

        expect(target.sent.map((entry) => entry.properties)).toEqual([
            { to: 'degraded', target: 'your-cluster', code: 'public_check_failed' },
            { to: 'unreachable', target: 'your-cluster', code: 'cluster_unreachable' },
            { to: 'recovered', target: 'your-cluster', code: 'healthy' },
        ]);
        expectClean(target.sent);
    });

    it('tells a lifecycle remove from an App Work deletion, and counts what may remain', () => {
        const target = sink();
        const listener = new AppRuntimeTelemetryListener(target);

        listener.onPaused(base);
        listener.onResumed(base);
        listener.onRemoved(base);
        listener.onRemoved({
            ...base,
            reason: 'app_work_deleted',
            code: 'attempts_exhausted',
            deletedCount: 3,
            kept: [{ kind: 'postgres', name: 'attachments-bucket' }],
            mayRemain: [
                { kind: 'Namespace', name: 'ew-hello-1a2b' },
                { kind: 'Component', name: 'web' },
            ],
        });

        expect(target.sent.map((entry) => [entry.event, entry.properties])).toEqual([
            ['app_lifecycle_action', { action: 'pause' }],
            ['app_lifecycle_action', { action: 'resume' }],
            ['app_lifecycle_action', { action: 'remove' }],
            [
                'app_work_deletion_outcome',
                { code: 'attempts_exhausted', deletedCount: 3, keptCount: 1, mayRemainCount: 2 },
            ],
        ]);
        expectClean(target.sent);
    });

    it('reports APW-07’s dependency events with kind, provider and reason only', () => {
        const target = sink();
        const listener = new AppRuntimeTelemetryListener(target);
        const dep = {
            workId: 'w1',
            userId: 'owner-1',
            kind: 'postgres',
            providerId: 'cnpg',
            connectionString: 'postgres://user:pw@host/db',
            namespace: 'ew-hello-1a2b',
        };

        listener.onDependencyProvisioned({ ...dep, actualVersion: '16' });
        listener.onDependencyFailed({ ...dep, reason: 'clusterUnreachable' });
        listener.onDependencyDataDeleted(dep);

        expect(target.sent.map((entry) => [entry.event, entry.properties])).toEqual([
            ['app_dependency_provisioned', { kind: 'postgres', providerId: 'cnpg' }],
            [
                'app_dependency_failed',
                { kind: 'postgres', providerId: 'cnpg', reason: 'clusterUnreachable' },
            ],
            ['app_dependency_data_deleted', { kind: 'postgres' }],
        ]);
        expectClean(target.sent);
    });

    it('drops every event when no sink is bound, and never throws', () => {
        const listener = new AppRuntimeTelemetryListener(undefined);
        expect(() => listener.onDeployFailed(base)).not.toThrow();
        expect(() => listener.onRemoved(null)).not.toThrow();
        expect(listener.stats()).toMatchObject({ emitted: 0, dropped: 2 });
    });
});

describe('AppEnvActivityService telemetry (APW-07 T39)', () => {
    function moduleRef(target: ReturnType<typeof sink> | null) {
        const log = { log: jest.fn(async () => undefined) };
        return {
            log,
            ref: {
                get: (token: unknown) => {
                    if (token === ActivityLogService) return log;
                    if (token === APP_WORKS_TELEMETRY_SINK && target) return target;
                    throw new UnknownElementException();
                },
            },
        };
    }

    it('reports an env change as a count and its verbs — never a name or value', async () => {
        const target = sink();
        const { ref, log } = moduleRef(target);
        const service = new AppEnvActivityService(ref as never);

        await service.emit({
            actionType: 'app_env',
            action: 'app.env.changed',
            status: 'completed',
            summary: 'Environment value DATABASE_URL set',
            details: {
                names: ['DATABASE_URL', 'SESSION_SECRET'],
                actions: ['set', 'reset', 'set'],
            },
            workId: 'w1',
            userId: 'u1',
        });
        await service.emit({
            actionType: 'app_env',
            action: 'app.env.rotated',
            status: 'completed',
            summary: 'Environment value SESSION_SECRET rotated',
            details: { name: 'SESSION_SECRET' },
            workId: 'w1',
            userId: 'u1',
        });

        // The Activity row keeps its names; telemetry never does.
        expect(log.log).toHaveBeenCalledTimes(2);
        expect(target.sent).toEqual([
            {
                distinctId: 'u1',
                event: 'app_env_values_changed',
                properties: { count: 2, actions: ['reset', 'set'] },
            },
            { distinctId: 'u1', event: 'app_env_rotated', properties: {} },
        ]);
        expect(JSON.stringify(target.sent)).not.toContain('DATABASE_URL');
        expect(JSON.stringify(target.sent)).not.toContain('SESSION_SECRET');
    });

    it('still writes the Activity row when no telemetry sink is bound', async () => {
        const { ref, log } = moduleRef(null);
        const service = new AppEnvActivityService(ref as never);
        await service.emit({
            actionType: 'app_env',
            action: 'app.env.changed',
            status: 'completed',
            summary: 'changed',
            details: { names: ['A'], actions: ['set'] },
            workId: 'w1',
            userId: 'u1',
        });
        expect(log.log).toHaveBeenCalledTimes(1);
    });
});
