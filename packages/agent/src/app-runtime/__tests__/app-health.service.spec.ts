/**
 * APW-06 T27 — the App runtime health poll (`app-health.service.ts`).
 *
 * Spec: FR-46, FR-47 (`spec.md:468-481`), FR-41 (`:442-447`), ACC-06-32 (`:771`), ACC-06-33
 * (`:772`). Plan: §9.3 (`plan.md:1287-1300` — the selection, the grouping, the 20 s budget, the
 * verdicts, the streak rules, the every-poll ingress re-validation and the every-10th egress
 * re-resolution), §7.2 (`:1042-1074` — the columns), §9.4 (`:1326-1348` — the three notification
 * rows and their dedupe keys). Task: `tasks.md:483-490`.
 *
 * Every assertion below is one line of that contract, and the ones T27's own task text names are
 * marked in their test names:
 *
 * - 4 failing polls ⇒ no notification, the 5th ⇒ one (ACC-06-32);
 * - failures spanning 7 h ⇒ two notifications, and a 5 h gap ⇒ still one;
 * - 3 consecutive passes ⇒ a recovery notification **only** when that streak's down notification
 *   was really created (ACC-06-32);
 * - 10 consecutive unreachable polls ⇒ `unreachable`, never `down`, with one notification
 *   (ACC-06-33);
 * - paused and deleting App Works are never polled;
 * - 5 concurrent polls per `clusterFingerprint`, and all clusters progress;
 * - **one poll never exceeds 20 s** — proved with `jest.useFakeTimers()`, never by waiting;
 * - the fail-closed answers: an unbound store is `health_store_unavailable`, a plugin without
 *   `getAppStatus` is refused by name, and `poll()` never throws.
 *
 * The fakes are the same shape `app-runtime-deletion.service.spec.ts` uses: one per optional seam,
 * every call journalled, and a store that really applies the patches it is handed — so the streak
 * tests are about ten successive polls of one row rather than about a mock's return value.
 */

import { Logger } from '@nestjs/common';
import type { AppSpec } from '@ever-works/contracts';
import type {
    AppComponentStatus,
    AppStatusSnapshot,
    AppStatusSpec,
    AppTargetRef,
    IDeploymentPlugin,
} from '@ever-works/plugin';

import {
    APP_HEALTH_CODE_CLUSTER_UNREACHABLE,
    APP_HEALTH_CODE_DNS_UNAVAILABLE,
    APP_HEALTH_CODE_OP_UNSUPPORTED,
    APP_HEALTH_CODE_POLL_TIMEOUT,
    APP_HEALTH_CODE_PUBLIC_CHECK_FAILED,
    APP_HEALTH_CONCURRENCY_PER_CLUSTER,
    APP_HEALTH_EGRESS_RESOLVE_EVERY,
    APP_HEALTH_EVENT_DEGRADED,
    APP_HEALTH_EVENT_RECOVERED,
    APP_HEALTH_EVENT_UNREACHABLE,
    APP_HEALTH_FAILURE_THRESHOLD,
    APP_HEALTH_NOTIFY_WINDOW_MS,
    APP_HEALTH_OP_DNS_RECONCILE,
    APP_HEALTH_POLL_LIMIT,
    APP_HEALTH_POLL_TIMEOUT_MS,
    APP_HEALTH_REASON_EGRESS_DRIFT,
    APP_HEALTH_RECOVERY_THRESHOLD,
    APP_HEALTH_SMOKE_WINDOW_S,
    APP_HEALTH_UNREACHABLE_THRESHOLD,
    AppHealthService,
    appHealthAddressIsPublic,
    appHealthStatusSpec,
    appHealthStreaks,
    appHealthVerdict,
    orderForPoll,
    type AppDnsReconcileOpPayload,
    type AppHealthAccessFacade,
    type AppHealthClusterAccess,
    type AppHealthEgressSource,
    type AppHealthNotificationProducers,
    type AppHealthOpDispatcher,
    type AppHealthStatePatch,
    type AppHealthStateStore,
    type AppHealthStateView,
} from '../app-health.service';
import type {
    AppPublicSmokeRequest,
    AppPublicSmokeRun,
    AppPublicSmokeService,
} from '../app-public-smoke.service';
import type { AppIngressReconcileOpPayload } from '../app-hosts.service';
import type { AppsDomainDnsService } from '../app-runtime-deletion.service';
import type {
    AppDeploySpecSnapshot,
    AppDeploySpecSource,
} from '../app-deploy-preconditions.service';
import type { AppRenderHosts, AppRenderHostSource } from '../app-render-input.builder';
import type { AppRuntimeEventSink } from '../ports';

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

const WORK = 'work-1';
const HOST = 'hello.example.test';
/** A genuinely public address — `203.0.113.0/24` is TEST-NET-3 and is refused by the policy. */
const PUBLIC_IP = '93.184.216.34';
const OTHER_PUBLIC_IP = '93.184.216.35';

/** §7.2's row, with the fields §9.3 reads. */
function stateRow(overrides: Partial<AppHealthStateView> = {}): AppHealthStateView {
    return {
        workId: WORK,
        target: 'your-cluster',
        namespace: 'ew-hello-1a2b3c4d',
        clusterFingerprint: 'fingerprint-1',
        currentDeploymentId: 'deployment-1',
        paused: false,
        removedAt: null,
        deletionRequestedAt: null,
        health: 'unknown',
        consecutiveFailures: 0,
        consecutivePasses: 0,
        unreachableStreak: 0,
        lastHealthNotifiedAt: null,
        lastPolledAt: null,
        ingressAddress: { ip: PUBLIC_IP, hostname: null },
        targetSettings: { tls: 'cert-manager' },
        userId: 'user-1',
        ...overrides,
    };
}

/** The App spec the status spec, the smoke checks and the primary component are read from. */
function appSpec(overrides: Record<string, unknown> = {}): AppSpec {
    return {
        components: [
            { name: 'web', role: 'web', replicas: 2 },
            { name: 'worker', role: 'worker', replicas: 1 },
        ],
        domains: { primaryComponent: 'web' },
        jobs: [{ name: 'migrate', component: 'web', when: 'pre-deploy' }],
        cron: [{ name: 'cleanup', component: 'web', schedule: '0 * * * *' }],
        smoke: [{ name: 'home', component: 'web', http: { path: '/' } }],
        ...overrides,
    } as unknown as AppSpec;
}

/** One component of a snapshot. */
function component(overrides: Partial<AppComponentStatus> = {}): AppComponentStatus {
    return {
        name: 'web',
        role: 'web',
        desired: 2,
        ready: 2,
        restarts: 0,
        ...overrides,
    } as AppComponentStatus;
}

/** A snapshot with the one web component healthy — the control every failing case is cut from. */
function healthySnapshot(overrides: Partial<AppStatusSnapshot> = {}): AppStatusSnapshot {
    return {
        observedAt: new Date().toISOString(),
        components: [component({ name: 'web', role: 'web', desired: 2, ready: 2 })],
        jobs: [],
        cron: [],
        isolationEnforced: null,
        ingressAddress: { ip: PUBLIC_IP },
        ...overrides,
    } as AppStatusSnapshot;
}

/** `down`: the primary web component has 0 ready (FR-47). */
function downSnapshot(): AppStatusSnapshot {
    return healthySnapshot({
        components: [component({ name: 'web', role: 'web', desired: 2, ready: 0 })],
    });
}

/** `degraded`: a web component below desired (FR-47). */
function degradedSnapshot(): AppStatusSnapshot {
    return healthySnapshot({
        components: [component({ name: 'web', role: 'web', desired: 2, ready: 1 })],
    });
}

/** What a status fake answers with, per call. */
type StatusAnswer = AppStatusSnapshot | 'throw' | 'hang';

/* -------------------------------------------------------------------------- *
 * Fakes — one per optional seam; the store really applies what it is handed
 * -------------------------------------------------------------------------- */

class FakeStates implements AppHealthStateStore {
    readonly healthPatches: Array<{ workId: string; patch: AppHealthStatePatch }> = [];
    readonly snapshots: Array<{ workId: string; snapshot: AppStatusSnapshot }> = [];
    selectLimit: number | null = null;
    getOrCreateCalls: string[] = [];
    selectThrows = false;
    recordThrows = false;

    constructor(readonly rows: AppHealthStateView[]) {}

    async selectForHealthPoll(limit: number): Promise<readonly AppHealthStateView[]> {
        this.selectLimit = limit;
        if (this.selectThrows) {
            throw new Error('the runtime-state table is gone');
        }

        return this.rows.map((row) => ({ ...row }));
    }

    async getOrCreate(workId: string): Promise<AppHealthStateView | null> {
        this.getOrCreateCalls.push(workId);
        const row = this.rows.find((candidate) => candidate.workId === workId);

        return row ? { ...row } : null;
    }

    async recordHealth(workId: string, patch: AppHealthStatePatch): Promise<void> {
        if (this.recordThrows) {
            throw new Error('the write was refused');
        }

        this.healthPatches.push({ workId, patch });

        const row = this.rows.find((candidate) => candidate.workId === workId);
        if (!row) return;

        row.health = patch.health;
        row.consecutiveFailures = patch.consecutiveFailures;
        row.consecutivePasses = patch.consecutivePasses;
        row.unreachableStreak = patch.unreachableStreak;
        row.lastPolledAt = patch.lastPolledAt;
        if (patch.lastHealthNotifiedAt !== undefined) {
            row.lastHealthNotifiedAt = patch.lastHealthNotifiedAt;
        }
        if (patch.ingressAddress !== undefined) {
            row.ingressAddress = patch.ingressAddress;
        }
    }

    async saveSnapshot(workId: string, snapshot: AppStatusSnapshot): Promise<void> {
        this.snapshots.push({ workId, snapshot });
    }

    /** The row as the *next* poll will read it — the value the streak rules must survive on. */
    row(workId: string = WORK): AppHealthStateView {
        return this.rows.find((candidate) => candidate.workId === workId);
    }
}

class FakeFacade implements AppHealthAccessFacade {
    readonly calls: string[] = [];
    refusal: string | null = null;
    throwFor: string | null = null;
    plugin: Record<string, unknown>;

    constructor(plugin: Record<string, unknown>) {
        this.plugin = plugin;
    }

    async resolveClusterAccess(
        workId: string,
    ): Promise<
        | { outcome: 'access'; access: AppHealthClusterAccess }
        | { outcome: 'refused'; refusal: string }
    > {
        this.calls.push(workId);
        if (this.throwFor === workId) {
            throw new Error('the plugin could not be resolved');
        }
        if (this.refusal) {
            return { outcome: 'refused', refusal: this.refusal };
        }

        return {
            outcome: 'access',
            access: {
                target: 'your-cluster',
                ref: { workId, namespace: 'ew-hello-1a2b3c4d', target: 'your-cluster' },
                credential: 'work-scoped-credential',
                plugin: this.plugin as unknown as IDeploymentPlugin,
            },
        };
    }
}

class FakeSpecs implements AppDeploySpecSource {
    readonly calls: string[] = [];

    constructor(
        private readonly answer: AppDeploySpecSnapshot | null = {
            status: 'valid',
            spec: appSpec(),
        },
    ) {}

    async getEffectiveSpec(workId: string): Promise<AppDeploySpecSnapshot | null> {
        this.calls.push(workId);

        return this.answer;
    }
}

class FakeHosts implements AppRenderHostSource {
    readonly calls: string[] = [];
    host: string | null = HOST;
    url: string | null = `https://${HOST}`;

    async primaryHost(): Promise<string | null> {
        this.calls.push('primaryHost');

        return this.host;
    }

    async resolveHosts(): Promise<AppRenderHosts | null> {
        this.calls.push('resolveHosts');
        if (!this.host) return null;

        return { primary: this.host, extra: [], previous: [], primaryUrl: this.url };
    }
}

class FakeSmoke {
    readonly requests: AppPublicSmokeRequest[] = [];
    answer: 'pass' | 'fail' | 'throw' = 'pass';

    async run(request: AppPublicSmokeRequest): Promise<AppPublicSmokeRun> {
        this.requests.push(request);
        if (this.answer === 'throw') {
            throw new Error('the smoke runner is not reachable');
        }

        return {
            checks: [],
            passed: this.answer === 'pass',
            outcome: this.answer === 'pass' ? 'passed' : 'failed',
            warnings: [],
            failures: [],
            healthRelevant: this.answer === 'fail',
            windowSeconds: request.windowSeconds ?? 0,
            attempts: 1,
            dns: null,
            observedAt: new Date().toISOString(),
        } as AppPublicSmokeRun;
    }
}

class FakeNotifications implements AppHealthNotificationProducers {
    readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    throws = false;

    private record(name: string, args: Record<string, unknown>): void {
        if (this.throws) {
            throw new Error('notifications are down');
        }
        this.calls.push({ name, args });
    }

    async notifyAppUnhealthy(args: {
        userId: string;
        workId: string;
        failureStreakStartMs: number;
    }): Promise<void> {
        this.record('notifyAppUnhealthy', args);
    }

    async notifyAppRecovered(args: {
        userId: string;
        workId: string;
        failureStreakStartMs: number;
    }): Promise<void> {
        this.record('notifyAppRecovered', args);
    }

    async notifyAppClusterUnreachable(args: {
        userId: string;
        workId: string;
        unreachableStreakStartMs: number;
    }): Promise<void> {
        this.record('notifyAppClusterUnreachable', args);
    }

    names(): string[] {
        return this.calls.map((call) => call.name);
    }
}

/** The service under test, with every seam bound to a fake that journals its calls. */
interface Harness {
    service: AppHealthService;
    states: FakeStates;
    facade: FakeFacade;
    specs: FakeSpecs | null;
    hosts: FakeHosts | null;
    smoke: FakeSmoke | null;
    events: Array<{ name: string; payload: Record<string, unknown> }>;
    notifications: FakeNotifications;
    dns: string[];
    dispatched: Array<AppIngressReconcileOpPayload | AppDnsReconcileOpPayload>;
    egress: { calls: number };
    statusCalls: Array<{ ref: AppTargetRef; spec: AppStatusSpec }>;
}

function harness(
    options: {
        rows?: AppHealthStateView[];
        withStore?: boolean;
        selectThrows?: boolean;
        recordThrows?: boolean;
        plugin?: Record<string, unknown> | null;
        refusal?: string | null;
        facadeThrows?: boolean;
        withFacade?: boolean;
        specs?: AppDeploySpecSnapshot | null;
        withSpecs?: boolean;
        withHosts?: boolean;
        host?: string | null;
        smoke?: 'pass' | 'fail' | 'throw';
        withSmoke?: boolean;
        withEvents?: boolean;
        withNotifications?: boolean;
        notificationsThrow?: boolean;
        withDns?: boolean;
        dnsThrows?: boolean;
        withOps?: boolean;
        opsThrow?: boolean;
        withEgress?: boolean;
        egressHosts?: (call: number) => readonly string[] | null;
        status?: (call: number) => StatusAnswer;
    } = {},
): Harness {
    const rows = options.rows ?? [stateRow()];
    const states = new FakeStates(rows);
    if (options.selectThrows) states.selectThrows = true;
    if (options.recordThrows) states.recordThrows = true;

    const statusCalls: Harness['statusCalls'] = [];
    let statusCall = 0;
    const status = options.status ?? (() => healthySnapshot());
    const plugin =
        options.plugin === null
            ? {}
            : (options.plugin ?? {
                  getAppStatus: async (
                      ref: AppTargetRef,
                      _credential: string,
                      spec: AppStatusSpec,
                  ) => {
                      statusCalls.push({ ref, spec });
                      const answer = status((statusCall += 1));
                      if (answer === 'throw') {
                          throw new Error('the cluster answered 401');
                      }
                      if (answer === 'hang') {
                          return new Promise<AppStatusSnapshot>(() => undefined);
                      }

                      return answer;
                  },
              });

    const facade = new FakeFacade(plugin);
    if (options.refusal) facade.refusal = options.refusal;
    if (options.facadeThrows) facade.throwFor = WORK;

    const specs = options.withSpecs === false ? null : new FakeSpecs(options.specs);
    const hosts = options.withHosts === false ? null : new FakeHosts();
    if (hosts && options.host !== undefined) {
        hosts.host = options.host;
        hosts.url = options.host ? `https://${options.host}` : null;
    }
    const smoke = options.withSmoke === false ? null : new FakeSmoke();
    if (smoke && options.smoke) smoke.answer = options.smoke;

    const events: Harness['events'] = [];
    const sink: AppRuntimeEventSink | undefined =
        options.withEvents === false
            ? undefined
            : {
                  emit: async (event) => {
                      events.push(event);
                  },
              };

    const notifications = new FakeNotifications();
    if (options.notificationsThrow) notifications.throws = true;
    const dns: string[] = [];
    const dnsService: AppsDomainDnsService | undefined =
        options.withDns === false
            ? undefined
            : {
                  removeRecord: async (workId: string) => {
                      if (options.dnsThrows) {
                          throw new Error('the DNS provider is unreachable');
                      }
                      dns.push(workId);

                      return true;
                  },
              };

    const dispatched: Harness['dispatched'] = [];
    const ops: AppHealthOpDispatcher | undefined =
        options.withOps === false
            ? undefined
            : {
                  dispatch: async (payload) => {
                      if (options.opsThrow) {
                          throw new Error('the dispatcher refused');
                      }
                      dispatched.push(payload);

                      return 'job-1';
                  },
              };

    const egressJournal = { calls: 0 };
    const egress: AppHealthEgressSource | undefined =
        options.withEgress === false
            ? undefined
            : {
                  resolveEgressHosts: async () => {
                      egressJournal.calls += 1;

                      return options.egressHosts
                          ? options.egressHosts(egressJournal.calls)
                          : ['db.internal'];
                  },
              };

    const service = new AppHealthService(
        options.withStore === false ? undefined : states,
        options.withFacade === false ? undefined : facade,
        specs ?? undefined,
        hosts ?? undefined,
        smoke as unknown as AppPublicSmokeService,
        sink,
        options.withNotifications === false ? undefined : notifications,
        dnsService,
        ops,
        egress,
    );

    return {
        service,
        states,
        facade,
        specs,
        hosts,
        smoke,
        events,
        notifications,
        dns,
        dispatched,
        egress: egressJournal,
        statusCalls,
    };
}

/** The streak state of one row, as the next poll will read it. */
function streakOf(states: FakeStates, workId: string = WORK): AppHealthStateView {
    return states.row(workId);
}

let warn: jest.SpyInstance;

beforeEach(() => {
    // Every refusal is named in a log line; the spy both keeps the output readable and lets a test
    // assert the *name* of a refusal that a summary only counts.
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
});

/** Every warning the service logged, as one searchable string. */
function warnings(): string {
    return warn.mock.calls.map((call) => String(call[0])).join('\n');
}

/* -------------------------------------------------------------------------- *
 * Pure helpers
 * -------------------------------------------------------------------------- */

describe('the numbers the plan fixes', () => {
    /**
     * §9.3 and FR-47 state each of these as a literal, and every behaviour below is written against
     * whichever the module exports — so the numbers themselves are pinned here. Without this block a
     * mutation that changes one of them can be *adopted* by a test that reads the same constant
     * (which is exactly what happened to the 20 s budget the first time this file was perturbed).
     */
    it('are §9.3 s LIMIT 500, 5 per cluster and a 20 s poll; FR-47 s 5 / 3 / 10 and §9.4 s 6 h, every 10th', () => {
        expect(APP_HEALTH_POLL_LIMIT).toBe(500);
        expect(APP_HEALTH_CONCURRENCY_PER_CLUSTER).toBe(5);
        expect(APP_HEALTH_POLL_TIMEOUT_MS).toBe(20_000);
        expect(APP_HEALTH_FAILURE_THRESHOLD).toBe(5);
        expect(APP_HEALTH_RECOVERY_THRESHOLD).toBe(3);
        expect(APP_HEALTH_UNREACHABLE_THRESHOLD).toBe(10);
        expect(APP_HEALTH_NOTIFY_WINDOW_MS).toBe(6 * 60 * 60 * 1_000);
        expect(APP_HEALTH_EGRESS_RESOLVE_EVERY).toBe(10);
    });
});

describe('appHealthVerdict', () => {
    it('is down when the primary web component has 0 ready, whatever else is healthy', () => {
        expect(
            appHealthVerdict({
                components: [
                    component({ name: 'web', role: 'web', desired: 2, ready: 0 }),
                    component({ name: 'worker', role: 'worker', desired: 1, ready: 1 }),
                ],
                primaryComponent: 'web',
            }),
        ).toBe('down');
    });

    it('is degraded when a web component is below desired, and healthy when none is', () => {
        expect(
            appHealthVerdict({
                components: [component({ name: 'web', role: 'web', desired: 2, ready: 1 })],
                primaryComponent: 'web',
            }),
        ).toBe('degraded');
        expect(
            appHealthVerdict({
                components: [component({ name: 'web', role: 'web', desired: 2, ready: 2 })],
                primaryComponent: 'web',
            }),
        ).toBe('healthy');
    });

    it('is degraded when the public check failed, even with every component ready', () => {
        expect(
            appHealthVerdict({
                components: [component({ name: 'web', role: 'web', desired: 2, ready: 2 })],
                primaryComponent: 'web',
                publicCheckFailed: true,
            }),
        ).toBe('degraded');
    });

    it('never reports healthy from no evidence: an empty snapshot is degraded', () => {
        expect(appHealthVerdict({ components: [], primaryComponent: 'web' })).toBe('degraded');
        expect(appHealthVerdict({ components: null, primaryComponent: null })).toBe('degraded');
    });

    it('is degraded when the declared primary was not observed at all', () => {
        expect(
            appHealthVerdict({
                components: [component({ name: 'other', role: 'web', desired: 1, ready: 1 })],
                primaryComponent: 'web',
            }),
        ).toBe('degraded');
    });

    it('judges a worker-only App spec on its own components rather than on a missing web one', () => {
        expect(
            appHealthVerdict({
                components: [component({ name: 'worker', role: 'worker', desired: 2, ready: 2 })],
                primaryComponent: null,
            }),
        ).toBe('healthy');
    });
});

describe('appHealthStreaks', () => {
    const base = { nowMs: 1_700_000_000_000 };

    it('does not notify on the 4th failing poll and does on the 5th', () => {
        // The input is the row's counter *before* this poll: 3 means this is the 4th failing poll.
        const fourth = appHealthStreaks({ ...base, verdict: 'down', consecutiveFailures: 3 });
        const fifth = appHealthStreaks({ ...base, verdict: 'down', consecutiveFailures: 4 });

        expect(fourth.notifyUnhealthy).toBe(false);
        expect(fourth.failures).toBe(4);
        expect(fifth.notifyUnhealthy).toBe(true);
        expect(fifth.failures).toBe(APP_HEALTH_FAILURE_THRESHOLD);
    });

    it('enforces the 6 h window from runtime state, so a second outage inside it is silent', () => {
        const notified = base.nowMs - APP_HEALTH_NOTIFY_WINDOW_MS + 1;
        const outside = base.nowMs - APP_HEALTH_NOTIFY_WINDOW_MS;

        expect(
            appHealthStreaks({
                ...base,
                verdict: 'down',
                consecutiveFailures: 9,
                lastHealthNotifiedAtMs: notified,
            }).notifyUnhealthy,
        ).toBe(false);
        expect(
            appHealthStreaks({
                ...base,
                verdict: 'down',
                consecutiveFailures: 9,
                lastHealthNotifiedAtMs: outside,
            }).notifyUnhealthy,
        ).toBe(true);
    });

    it('recovers after 3 passes only when a failure notification was really created', () => {
        expect(
            appHealthStreaks({ ...base, verdict: 'healthy', consecutivePasses: 2 }).notifyRecovered,
        ).toBe(false);
        expect(
            appHealthStreaks({
                ...base,
                verdict: 'healthy',
                consecutivePasses: 2,
                lastHealthNotifiedAtMs: base.nowMs - 60_000,
            }).notifyRecovered,
        ).toBe(true);
        // The same handle again: that streak's recovery has already been sent.
        expect(
            appHealthStreaks({
                ...base,
                verdict: 'healthy',
                consecutivePasses: 4,
                lastHealthNotifiedAtMs: base.nowMs - 60_000,
                recoveredForMs: base.nowMs - 60_000,
            }).notifyRecovered,
        ).toBe(false);
    });

    it('notifies on exactly the 10th consecutive unreachable poll, and never counts it as a failure', () => {
        const ninth = appHealthStreaks({ ...base, verdict: 'unreachable', unreachableStreak: 8 });
        const tenth = appHealthStreaks({ ...base, verdict: 'unreachable', unreachableStreak: 9 });
        const eleventh = appHealthStreaks({
            ...base,
            verdict: 'unreachable',
            unreachableStreak: 10,
        });

        expect(ninth.notifyUnreachable).toBe(false);
        expect(tenth.unreachable).toBe(APP_HEALTH_UNREACHABLE_THRESHOLD);
        expect(tenth.notifyUnreachable).toBe(true);
        expect(eleventh.notifyUnreachable).toBe(false);
        expect(tenth.failures).toBe(0);
        expect(tenth.notifyUnhealthy).toBe(false);
    });

    it('resets the app counters on an unreachable poll, because reaching nothing grades nothing', () => {
        const outcome = appHealthStreaks({
            ...base,
            verdict: 'unreachable',
            consecutiveFailures: 4,
            consecutivePasses: 2,
            unreachableStreak: 0,
        });

        expect(outcome.failures).toBe(0);
        expect(outcome.passes).toBe(0);
        expect(outcome.unreachable).toBe(1);
    });

    it('names a transition only when the health actually changed', () => {
        expect(appHealthStreaks({ ...base, verdict: 'down', health: 'down' }).transition).toBe(
            false,
        );
        expect(appHealthStreaks({ ...base, verdict: 'down', health: 'healthy' }).transition).toBe(
            true,
        );
        expect(
            appHealthStreaks({ ...base, verdict: 'healthy', health: 'unknown' }).transition,
        ).toBe(true);
    });
});

describe('appHealthAddressIsPublic', () => {
    it('accepts public addresses and hostnames', () => {
        expect(appHealthAddressIsPublic('8.8.8.8')).toBe(true);
        expect(appHealthAddressIsPublic('64:ff9b::808:808')).toBe(true);
        expect(appHealthAddressIsPublic(HOST)).toBe(true);
    });

    it('refuses every private, loopback, link-local, CGNAT and mapped form', () => {
        for (const address of [
            '10.0.0.1',
            '127.0.0.1',
            '169.254.169.254',
            '172.16.0.1',
            '192.168.1.10',
            '100.64.0.1',
            '198.18.0.1',
            '203.0.113.10',
            '::1',
            'fc00::1',
            'fe80::1',
            '::ffff:10.0.0.1',
            '64:ff9b::a00:1',
            '',
            null,
        ]) {
            expect(appHealthAddressIsPublic(address)).toBe(false);
        }
    });
});

describe('appHealthStatusSpec', () => {
    it('carries the spec components with their roles, replicas and primary flag, plus job and cron names', () => {
        expect(appHealthStatusSpec(appSpec(), 'ew-hello-1a2b3c4d')).toEqual({
            components: [
                { name: 'web', role: 'web', replicas: 2, primary: true },
                { name: 'worker', role: 'worker', replicas: 1, primary: false },
            ],
            jobs: ['migrate'],
            cron: ['cleanup'],
        });
    });
});

describe('orderForPoll', () => {
    it('puts the never-polled rows first and then the oldest, which is §9.3 s NULLS FIRST', () => {
        const rows = [
            { workId: 'recent', lastPolledAt: new Date(2_000) },
            { workId: 'never', lastPolledAt: null },
            { workId: 'oldest', lastPolledAt: new Date(1_000) },
        ];

        expect(orderForPoll(rows).map((row) => row.workId)).toEqual(['never', 'oldest', 'recent']);
    });
});

/* -------------------------------------------------------------------------- *
 * The poll — §9.3
 * -------------------------------------------------------------------------- */

describe('AppHealthService.poll — the selection', () => {
    it('asks the store for §9.3 s LIMIT 500 and polls in NULLS-FIRST order', async () => {
        const h = harness({
            rows: [
                stateRow({ workId: 'recent', lastPolledAt: new Date(Date.now() - 60_000) }),
                stateRow({ workId: 'never', lastPolledAt: null }),
            ],
        });

        const summary = await h.service.poll();

        expect(h.states.selectLimit).toBe(APP_HEALTH_POLL_LIMIT);
        expect(summary.selected).toBe(2);
        expect(summary.polled).toBe(2);
        expect(h.facade.calls).toEqual(['never', 'recent']);
    });

    it('never selects more than the 500 cap, even when the store ignores the limit', async () => {
        const h = harness();
        jest.spyOn(h.states, 'selectForHealthPoll').mockResolvedValue(
            Array.from({ length: APP_HEALTH_POLL_LIMIT + 25 }, (_, index) =>
                stateRow({ workId: `extra-${index}` }),
            ),
        );

        const summary = await h.service.poll();

        expect(summary.selected).toBe(APP_HEALTH_POLL_LIMIT);
        expect(summary.polled).toBe(APP_HEALTH_POLL_LIMIT);
    });

    it('honours a caller s limit and refuses to raise it above the cap', async () => {
        const h = harness({ rows: [stateRow({ workId: 'a' }), stateRow({ workId: 'b' })] });

        await h.service.poll({ limit: 1 });
        expect(h.states.selectLimit).toBe(1);

        await h.service.poll({ limit: 5_000 });
        expect(h.states.selectLimit).toBe(APP_HEALTH_POLL_LIMIT);
    });

    it('skips paused, deleting, removed, target-less and not-deployed App Works without polling them', async () => {
        const h = harness({
            rows: [
                stateRow({ workId: 'pollable' }),
                stateRow({ workId: 'paused', paused: true }),
                stateRow({ workId: 'deleting', deletionRequestedAt: new Date() }),
                stateRow({ workId: 'removed', removedAt: new Date() }),
                stateRow({ workId: 'none', target: 'none' }),
                stateRow({ workId: 'undeployed', currentDeploymentId: null }),
            ],
        });

        const summary = await h.service.poll();

        expect(summary).toMatchObject({ ok: true, selected: 6, polled: 1, skipped: 5 });
        expect(h.statusCalls).toHaveLength(1);
        expect(h.states.healthPatches.map((patch) => patch.workId)).toEqual(['pollable']);
        expect(warnings()).toContain('paused');
        expect(warnings()).toContain('deleting');
        expect(warnings()).toContain('removed');
    });
});

describe('AppHealthService.poll — one poll s work', () => {
    it('calls getAppStatus with the spec s components and runs the first GET smoke check over the public URL', async () => {
        const h = harness();

        await h.service.poll();

        expect(h.statusCalls).toHaveLength(1);
        expect(h.statusCalls[0].spec.components).toEqual([
            { name: 'web', role: 'web', replicas: 2, primary: true },
            { name: 'worker', role: 'worker', replicas: 1, primary: false },
        ]);
        expect(h.smoke.requests).toHaveLength(1);
        expect(h.smoke.requests[0]).toMatchObject({
            workId: WORK,
            urls: [`https://${HOST}`],
            windowSeconds: APP_HEALTH_SMOKE_WINDOW_S,
            isFirstDeploymentOnCluster: false,
            ingressAddresses: [PUBLIC_IP],
        });
        expect(h.smoke.requests[0].checks.map((check) => check.name)).toEqual(['home']);
    });

    it('never runs a check that belongs to the first Deployment only', async () => {
        const h = harness({
            specs: {
                status: 'valid',
                spec: appSpec({
                    smoke: [
                        {
                            name: 'first',
                            component: 'web',
                            http: { path: '/' },
                            when: 'first-deploy',
                        },
                        { name: 'home', component: 'web', http: { path: '/' } },
                    ],
                }),
            },
        });

        await h.service.poll();

        expect(h.smoke.requests[0].checks.map((check) => check.name)).toEqual(['home']);
    });

    it('degrades when the public check failed, and stays healthy when it only warned', async () => {
        const failing = harness({ smoke: 'fail' });
        expect((await failing.service.poll()).verdicts).toMatchObject({ degraded: 1, healthy: 0 });
        expect(failing.events[0].payload.code).toBe(APP_HEALTH_CODE_PUBLIC_CHECK_FAILED);

        const passing = harness({ smoke: 'pass' });
        expect((await passing.service.poll()).verdicts).toMatchObject({ healthy: 1 });
    });

    it('records the verdict, the snapshot and lastPolledAt, and emits the transition', async () => {
        const h = harness({ status: () => downSnapshot() });

        const summary = await h.service.poll();

        expect(summary).toMatchObject({
            ok: true,
            polled: 1,
            verdicts: { healthy: 0, degraded: 0, down: 1, unreachable: 0 },
        });
        expect(h.states.snapshots).toHaveLength(1);
        expect(streakOf(h.states)).toMatchObject({
            health: 'down',
            consecutiveFailures: 1,
            consecutivePasses: 0,
        });
        expect(h.events.map((event) => event.name)).toEqual([APP_HEALTH_EVENT_DEGRADED]);
        expect(h.events[0].payload).toMatchObject({
            workId: WORK,
            userId: 'user-1',
            target: 'your-cluster',
            code: 'down',
            names: ['web'],
        });
    });

    it('emits no second event while the state does not change', async () => {
        const h = harness({ status: () => healthySnapshot() });

        await h.service.poll();
        await h.service.poll();

        expect(h.events.map((event) => event.name)).toEqual([APP_HEALTH_EVENT_RECOVERED]);
    });

    it('carries no value, host, token or log text in any event payload', async () => {
        const h = harness({ status: (call) => (call === 1 ? downSnapshot() : healthySnapshot()) });

        await h.service.poll();
        await h.service.poll();
        await h.service.poll();
        await h.service.poll();

        expect(h.events.map((event) => event.name)).toEqual([
            APP_HEALTH_EVENT_DEGRADED,
            APP_HEALTH_EVENT_RECOVERED,
        ]);

        for (const event of h.events) {
            expect(Object.keys(event.payload).sort()).toEqual([
                'code',
                'names',
                'target',
                'userId',
                'workId',
            ]);
            const serialised = JSON.stringify(event.payload);
            expect(serialised).not.toContain(HOST);
            expect(serialised).not.toContain('work-scoped-credential');
            expect(serialised).not.toContain('ew-hello-1a2b3c4d');
            expect(serialised).not.toMatch(/value|token|kubeconfig|secret/i);
        }
    });
});

describe('AppHealthService.poll — FR-47 s streak rules (ACC-06-32)', () => {
    it('sends nothing on 4 failing polls and one notification on the 5th', async () => {
        const h = harness({ status: () => downSnapshot() });

        for (let poll = 1; poll <= 4; poll += 1) {
            const summary = await h.service.poll();
            expect(summary.notifications).toBe(0);
            expect(h.notifications.calls).toHaveLength(0);
        }

        expect(streakOf(h.states).consecutiveFailures).toBe(4);
        expect(streakOf(h.states).lastHealthNotifiedAt).toBeNull();

        const fifth = await h.service.poll();

        expect(fifth.notifications).toBe(1);
        expect(h.notifications.names()).toEqual(['notifyAppUnhealthy']);
        expect(h.notifications.calls[0].args).toMatchObject({ userId: 'user-1', workId: WORK });
        expect(typeof h.notifications.calls[0].args.failureStreakStartMs).toBe('number');
        expect(streakOf(h.states).lastHealthNotifiedAt).not.toBeNull();
    });

    it('sends one notification per 6 h: silent at 5 h, sent again once 7 h of failures have passed', async () => {
        jest.useFakeTimers();
        const h = harness({ status: () => downSnapshot() });

        for (let poll = 0; poll < APP_HEALTH_FAILURE_THRESHOLD; poll += 1) {
            await h.service.poll();
        }
        expect(h.notifications.names()).toEqual(['notifyAppUnhealthy']);

        // 5 h later — still inside §9.3 s window, so the failing polls stay silent.
        jest.setSystemTime(Date.now() + 5 * 60 * 60 * 1_000);
        await h.service.poll();
        await h.service.poll();
        expect(h.notifications.names()).toEqual(['notifyAppUnhealthy']);

        // 7 h after the first notification — outside the window, so the outage is reported again.
        jest.setSystemTime(Date.now() + 2 * 60 * 60 * 1_000);
        const summary = await h.service.poll();

        expect(summary.notifications).toBe(1);
        expect(h.notifications.names()).toEqual(['notifyAppUnhealthy', 'notifyAppUnhealthy']);
    });

    it('never sends a recovery notification unless that streak s down notification was created', async () => {
        const silent = harness({
            status: (call) => (call <= 2 ? downSnapshot() : healthySnapshot()),
        });

        for (let poll = 0; poll < 5; poll += 1) {
            await silent.service.poll();
        }

        // Two failing polls only: no down notification, so no recovery follows (ACC-06-32).
        expect(silent.notifications.calls).toHaveLength(0);
        expect(streakOf(silent.states).consecutivePasses).toBeGreaterThanOrEqual(
            APP_HEALTH_RECOVERY_THRESHOLD,
        );

        const notified = harness({
            status: (call) => (call <= 5 ? downSnapshot() : healthySnapshot()),
        });

        for (let poll = 0; poll < 5; poll += 1) {
            await notified.service.poll();
        }
        expect(notified.notifications.names()).toEqual(['notifyAppUnhealthy']);
        const handle = notified.notifications.calls[0].args.failureStreakStartMs;

        // The 1st and 2nd passing polls: no recovery yet (ACC-06-32 s "3 consecutive passes").
        await notified.service.poll();
        await notified.service.poll();
        expect(notified.notifications.names()).toEqual(['notifyAppUnhealthy']);

        const third = await notified.service.poll();

        expect(third.notifications).toBe(1);
        expect(notified.notifications.names()).toEqual([
            'notifyAppUnhealthy',
            'notifyAppRecovered',
        ]);
        // §9.4:1346 — the recovery key reuses the very handle the down key carried.
        expect(notified.notifications.calls[1].args.failureStreakStartMs).toBe(handle);

        // A 4th passing poll does not send it again.
        await notified.service.poll();
        expect(notified.notifications.names()).toEqual([
            'notifyAppUnhealthy',
            'notifyAppRecovered',
        ]);
    });

    it('concludes unreachable, never down, after 10 consecutive unreachable polls, with one notification (ACC-06-33)', async () => {
        const h = harness({ status: () => 'throw' });

        for (let poll = 1; poll <= APP_HEALTH_UNREACHABLE_THRESHOLD - 1; poll += 1) {
            const summary = await h.service.poll();
            expect(summary.verdicts).toMatchObject({ unreachable: 1, down: 0 });
        }
        expect(h.notifications.calls).toHaveLength(0);

        const tenth = await h.service.poll();

        expect(tenth.verdicts).toMatchObject({ unreachable: 1, down: 0 });
        expect(tenth.notifications).toBe(1);
        expect(h.notifications.names()).toEqual(['notifyAppClusterUnreachable']);
        expect(streakOf(h.states)).toMatchObject({
            health: 'unreachable',
            unreachableStreak: APP_HEALTH_UNREACHABLE_THRESHOLD,
            consecutiveFailures: 0,
        });
        expect(h.events.map((event) => event.name)).toEqual([APP_HEALTH_EVENT_UNREACHABLE]);
        expect(h.events[0].payload).toMatchObject({ code: APP_HEALTH_CODE_CLUSTER_UNREACHABLE });
    });

    it('does not let an unreachable poll push a failure streak towards the down notification', async () => {
        // 4 failing polls, one cluster blip, then a 5th failing poll: still not 5 consecutive failures.
        const h = harness({ status: (call) => (call === 5 ? 'throw' : downSnapshot()) });

        for (let poll = 1; poll <= 4; poll += 1) {
            await h.service.poll();
        }
        await h.service.poll();
        const after = await h.service.poll();

        expect(after.verdicts.down).toBe(1);
        expect(h.notifications.calls).toHaveLength(0);
        expect(streakOf(h.states).consecutiveFailures).toBe(1);
    });
});

describe('AppHealthService.poll — concurrency and the 20 s budget (§9.3)', () => {
    it('polls at most 5 concurrently within one cluster, and does reach 5', async () => {
        const rows = Array.from({ length: 12 }, (_, index) =>
            stateRow({ workId: `work-${index}`, clusterFingerprint: 'one-cluster' }),
        );
        let inFlight = 0;
        let peak = 0;

        const h = harness({ rows });
        // The status fake resolves on a macrotask, so every lane that started before the first
        // resolution is genuinely in flight at the same moment.
        h.facade.plugin = {
            getAppStatus: async (ref: AppTargetRef, _credential: string, spec: AppStatusSpec) => {
                h.statusCalls.push({ ref, spec });
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await new Promise((resolve) => setImmediate(resolve));
                inFlight -= 1;

                return healthySnapshot();
            },
        };

        const summary = await h.service.poll();

        expect(summary.polled).toBe(12);
        expect(peak).toBe(APP_HEALTH_CONCURRENCY_PER_CLUSTER);
    });

    it('gives every cluster its own 5 lanes, so one slow cluster cannot starve another', async () => {
        const rows = [
            ...Array.from({ length: 6 }, (_, index) =>
                stateRow({ workId: `a-${index}`, clusterFingerprint: 'cluster-a' }),
            ),
            ...Array.from({ length: 6 }, (_, index) =>
                stateRow({ workId: `b-${index}`, clusterFingerprint: 'cluster-b' }),
            ),
        ];
        const peakPerCluster: Record<string, number> = {};
        const inFlight: Record<string, number> = {};

        const h = harness({ rows });
        h.facade.plugin = {
            getAppStatus: async (ref: AppTargetRef, _credential: string, spec: AppStatusSpec) => {
                h.statusCalls.push({ ref, spec });
                const cluster = ref.workId.startsWith('a-') ? 'cluster-a' : 'cluster-b';
                inFlight[cluster] = (inFlight[cluster] ?? 0) + 1;
                peakPerCluster[cluster] = Math.max(peakPerCluster[cluster] ?? 0, inFlight[cluster]);
                await new Promise((resolve) => setImmediate(resolve));
                inFlight[cluster] -= 1;

                return healthySnapshot();
            },
        };

        const summary = await h.service.poll();

        expect(summary.polled).toBe(12);
        expect(peakPerCluster['cluster-a']).toBe(APP_HEALTH_CONCURRENCY_PER_CLUSTER);
        expect(peakPerCluster['cluster-b']).toBe(APP_HEALTH_CONCURRENCY_PER_CLUSTER);
    });

    it('never lets one poll exceed 20 s, and resolves the timed-out poll as unreachable', async () => {
        jest.useFakeTimers();
        // §9.3's own number, spelled as the plan spells it rather than read from the constant: the
        // budget is 20 s, and a poll that stopped at 1 s (or at 40 s) is a broken poll — a test that
        // asked the constant would follow the mutation instead of catching it.
        const budgetMs = 20_000;
        const startedAt = Date.now();
        const h = harness({ status: () => 'hang' });

        const pending = h.service.poll();
        let settled = false;
        void pending.then(() => {
            settled = true;
        });

        // One millisecond short of §9.3's budget the poll is still inside it: the bound is not a
        // wish, it is the moment the poll gives up — and it gives up at exactly that moment.
        await jest.advanceTimersByTimeAsync(budgetMs - 1);
        expect(settled).toBe(false);

        await jest.advanceTimersByTimeAsync(1);
        const summary = await pending;

        expect(summary).toMatchObject({
            ok: true,
            polled: 1,
            verdicts: { healthy: 0, degraded: 0, down: 0, unreachable: 1 },
        });
        expect(Date.now() - startedAt).toBe(budgetMs);
        expect(streakOf(h.states)).toMatchObject({ health: 'unreachable', unreachableStreak: 1 });
        expect(warnings()).toContain(APP_HEALTH_CODE_POLL_TIMEOUT);
    });

    it('does not wait for the 20 s budget when the observation answers at once', async () => {
        jest.useFakeTimers();
        const startedAt = Date.now();
        const h = harness();

        const summary = await h.service.poll();

        expect(summary.polled).toBe(1);
        expect(Date.now() - startedAt).toBe(0);
    });
});

describe('AppHealthService.poll — FR-41 s ingress address, re-validated on every poll', () => {
    it('updates the stored address on the poll that sees it change, not on the 10th', async () => {
        const h = harness({
            status: (call) =>
                call === 1
                    ? healthySnapshot()
                    : healthySnapshot({ ingressAddress: { ip: OTHER_PUBLIC_IP } }),
        });

        await h.service.poll();
        expect(h.states.healthPatches[0].patch.ingressAddress).toBeUndefined();

        await h.service.poll();

        expect(h.states.healthPatches[1].patch.ingressAddress).toEqual({
            ip: OTHER_PUBLIC_IP,
            hostname: null,
        });
        expect(streakOf(h.states).ingressAddress).toEqual({ ip: OTHER_PUBLIC_IP, hostname: null });
    });

    it('withdraws the address when it stops being public, and clears it', async () => {
        const h = harness({
            status: () => healthySnapshot({ ingressAddress: { ip: '10.0.0.5' } }),
        });

        await h.service.poll();

        expect(h.dns).toEqual([WORK]);
        expect(h.states.healthPatches[0].patch.ingressAddress).toBeNull();
        expect(streakOf(h.states).ingressAddress).toBeNull();
    });

    it('reports a withdrawal it could not carry out instead of pretending the record is gone', async () => {
        const h = harness({
            status: () => healthySnapshot({ ingressAddress: { ip: '192.168.1.5' } }),
            dnsThrows: true,
        });

        const summary = await h.service.poll();

        expect(summary.ok).toBe(true);
        expect(warnings()).toContain(APP_HEALTH_CODE_DNS_UNAVAILABLE);
        expect(h.states.healthPatches[0].patch.ingressAddress).toBeNull();
    });

    it('leaves the stored address alone when the snapshot reports none', async () => {
        const h = harness({ status: () => healthySnapshot({ ingressAddress: null }) });

        await h.service.poll();

        expect(h.states.healthPatches[0].patch.ingressAddress).toBeUndefined();
        expect(streakOf(h.states).ingressAddress).toEqual({ ip: PUBLIC_IP, hostname: null });
    });
});

describe('AppHealthService.poll — the every-10th egress re-resolution (§9.3)', () => {
    it('re-resolves on every 10th poll and dispatches both reconcile ops on drift', async () => {
        const h = harness({
            egressHosts: (call) =>
                call === 1 ? ['db.internal', 'cache.internal'] : ['db.internal'],
        });

        for (let poll = 1; poll < 2 * APP_HEALTH_EGRESS_RESOLVE_EVERY; poll += 1) {
            await h.service.poll();
        }

        // The 10th poll established the baseline; a first observation cannot be drift.
        expect(h.egress.calls).toBe(1);
        expect(h.dispatched).toHaveLength(0);

        await h.service.poll();

        expect(h.egress.calls).toBe(2);
        expect(h.dispatched.map((payload) => payload.op)).toEqual([
            'ingress-reconcile',
            APP_HEALTH_OP_DNS_RECONCILE,
        ]);
        for (const payload of h.dispatched) {
            expect(payload).toMatchObject({ workId: WORK, reason: APP_HEALTH_REASON_EGRESS_DRIFT });
        }
    });

    it('dispatches nothing when the egress set is unchanged, and nothing on the establishing poll', async () => {
        const h = harness({ egressHosts: () => ['db.internal'] });

        for (let poll = 1; poll <= 2 * APP_HEALTH_EGRESS_RESOLVE_EVERY; poll += 1) {
            await h.service.poll();
        }

        expect(h.egress.calls).toBe(2);
        expect(h.dispatched).toHaveLength(0);
    });

    it('reports an unbound dispatcher and an unanswered egress source rather than faking either', async () => {
        const noOps = harness({
            withOps: false,
            egressHosts: (call) => (call === 1 ? ['a.internal'] : ['b.internal']),
        });
        for (let poll = 1; poll <= 2 * APP_HEALTH_EGRESS_RESOLVE_EVERY; poll += 1) {
            expect((await noOps.service.poll()).ok).toBe(true);
        }
        expect(noOps.dispatched).toHaveLength(0);
        expect(warnings()).toContain('dispatcher_unavailable');

        const noSource = harness({ withEgress: false });
        for (let poll = 1; poll <= APP_HEALTH_EGRESS_RESOLVE_EVERY; poll += 1) {
            expect((await noSource.service.poll()).ok).toBe(true);
        }
        expect(warnings()).toContain('egress_source_unavailable');
    });
});

describe('AppHealthService.poll — the manual single-Work path', () => {
    it('polls exactly the Work it was asked for', async () => {
        const h = harness({
            rows: [stateRow({ workId: 'wanted' }), stateRow({ workId: 'other' })],
        });

        const summary = await h.service.poll({ workId: 'wanted' });

        expect(h.states.getOrCreateCalls).toEqual(['wanted']);
        expect(h.facade.calls).toEqual(['wanted']);
        expect(summary).toMatchObject({ ok: true, selected: 1, polled: 1, skipped: 0 });
    });

    it('skips a paused Work rather than polling it on a manual refresh', async () => {
        const h = harness({ rows: [stateRow({ paused: true })] });

        const summary = await h.service.poll({ workId: WORK });

        expect(summary).toMatchObject({ ok: true, selected: 1, polled: 0, skipped: 1 });
        expect(h.statusCalls).toHaveLength(0);
    });
});

/* -------------------------------------------------------------------------- *
 * Fail-closed (§9.8 s rule, and T27 s "poll() never throws")
 * -------------------------------------------------------------------------- */

describe('AppHealthService.poll — fail-closed', () => {
    it('answers health_store_unavailable, and nothing else, when T17 s store is not bound', async () => {
        const h = harness({ withStore: false });

        expect(await h.service.poll()).toEqual({
            ok: false,
            reason: 'health_store_unavailable',
            selected: 0,
            polled: 0,
            skipped: 0,
            notifications: 0,
            verdicts: { healthy: 0, degraded: 0, down: 0, unreachable: 0 },
        });
    });

    it('is constructible with nothing bound at all, and refuses by name', async () => {
        const service = new AppHealthService();

        expect(await service.poll()).toMatchObject({
            ok: false,
            reason: 'health_store_unavailable',
        });
    });

    it('names each other absent collaborator rather than concluding a verdict from half the evidence', async () => {
        const cases: Array<[Parameters<typeof harness>[0], string]> = [
            [{ withSpecs: false }, 'health_spec_source_unavailable'],
            [{ withHosts: false }, 'health_host_source_unavailable'],
            [{ withSmoke: false }, 'health_smoke_unavailable'],
            [{ withFacade: false }, 'health_access_unavailable'],
        ];

        for (const [options, reason] of cases) {
            const h = harness(options);
            expect(await h.service.poll()).toMatchObject({ ok: false, reason });
        }
    });

    it('refuses a selection it could not read instead of reporting a sweep that never ran', async () => {
        const h = harness({ selectThrows: true });

        expect(await h.service.poll()).toMatchObject({
            ok: false,
            reason: 'health_store_unreadable',
            polled: 0,
        });
    });

    it('refuses op_unsupported_on_target when the materialised plugin has no getAppStatus', async () => {
        const h = harness({ plugin: null });

        const summary = await h.service.poll();

        expect(summary).toMatchObject({ ok: true, selected: 1, polled: 0, skipped: 1 });
        expect(h.statusCalls).toHaveLength(0);
        expect(warnings()).toContain(APP_HEALTH_CODE_OP_UNSUPPORTED);
    });

    it('skips a row whose cluster access was refused, with the facade s own code', async () => {
        const h = harness({ refusal: 'target_not_checked' });

        const summary = await h.service.poll();

        expect(summary).toMatchObject({ ok: true, polled: 0, skipped: 1 });
        expect(warnings()).toContain('target_not_checked');
    });

    it('skips a Work whose App spec cannot be read', async () => {
        const unreadable = harness({ specs: null });
        expect(await unreadable.service.poll()).toMatchObject({ polled: 0, skipped: 1 });
        expect(warnings()).toContain('spec_unavailable');

        const nothing = harness({ specs: { status: 'invalid', spec: null } });
        expect(await nothing.service.poll()).toMatchObject({ polled: 0, skipped: 1 });
    });

    it('turns a throwing or hanging collaborator into a verdict, never into an exception', async () => {
        const throwing = harness({
            status: () => 'throw',
            smoke: 'throw',
            notificationsThrow: true,
            opsThrow: true,
            dnsThrows: true,
            recordThrows: true,
            facadeThrows: true,
        });

        const summary = await throwing.service.poll();

        expect(summary).toMatchObject({ ok: true, polled: 1, verdicts: { unreachable: 1 } });
        expect(warnings()).toContain(APP_HEALTH_CODE_CLUSTER_UNREACHABLE);
    });

    it('keeps the sweep going when neither the event sink nor the notification producers are bound', async () => {
        const h = harness({
            withEvents: false,
            withNotifications: false,
            status: () => downSnapshot(),
        });

        for (let poll = 1; poll <= APP_HEALTH_FAILURE_THRESHOLD; poll += 1) {
            expect((await h.service.poll()).ok).toBe(true);
        }

        expect(h.notifications.names()).toEqual([]);
        expect(warnings()).toContain('no event sink is bound');
        expect(warnings()).toContain('that producer is not bound');
    });

    it('polls but does not notify when the row carries no owner to address', async () => {
        const h = harness({ rows: [stateRow({ userId: null })], status: () => downSnapshot() });

        for (let poll = 1; poll <= APP_HEALTH_FAILURE_THRESHOLD; poll += 1) {
            await h.service.poll();
        }

        expect(h.notifications.calls).toHaveLength(0);
        expect(streakOf(h.states).lastHealthNotifiedAt).toBeNull();
        expect(warnings()).toContain('no notification was created');
    });

    it('delivers a poll of a Work with no published host without failing its public half', async () => {
        const h = harness({ host: null });

        const summary = await h.service.poll();

        expect(summary).toMatchObject({ ok: true, verdicts: { healthy: 1 } });
        expect(h.smoke.requests).toHaveLength(0);
    });
});
