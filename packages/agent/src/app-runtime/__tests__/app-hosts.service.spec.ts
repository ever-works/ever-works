/**
 * APW-06 T26 (half one) — `AppHostsService` (plan §8.1, §8.2, §4.11; spec FR-38, FR-39, FR-40,
 * FR-41; ACC-06-25, ACC-06-26/APW06-G11, ACC-06-52).
 *
 * T26's Test line (`tasks.md:471-479`) names six cases for this file — "**unverified domain never in
 * `hosts`**; verify → `ingress-reconcile` dispatched with no Deployment requested (ACC-06-25);
 * primary change with `restart` requests a Deployment of the current Build and with `rebuild` calls
 * `AppBuildsService.requestRebuild` and stores the returned id in `pendingDomainRebuildBuildId`,
 * while a rate-limited or blocked request stores nothing and requests no Deployment (ACC-06-26,
 * APW06-G11); under strategy `image` `rebuild` behaves as `restart` with the `rebuild_not_applicable`
 * warning (ACC-06-52)" — and §8.1/§8.2 add the order itself: the primary is the **verified** custom
 * domain the owner marked primary, else the managed subdomain, else `null`; `extra` excludes the
 * primary; `previous` is carried only while a `rebuild` Deployment is pending; `appUrlScheme`
 * answers per TLS mode **and** per host kind.
 *
 * Every collaborator is a hand-written fake, so the suite also pins what was asked of them: that an
 * unverified row is never published, that the domain store is read once, and that a refusal stores
 * **no** marker and requests **no** Deployment — the two halves of ACC-06-26 that a state-only
 * assertion would miss.
 */

import { Logger } from '@nestjs/common';

import type { AppDeploySpecSnapshot } from '../app-deploy-preconditions.service';

import {
    APP_INGRESS_RECONCILE_OP,
    APP_HOSTS_CODE_REBUILD_BLOCKED,
    APP_HOSTS_CODE_REBUILD_RATE_LIMITED,
    APP_HOSTS_CODE_REBUILD_UNAVAILABLE,
    APP_HOSTS_CODE_RECONCILE_UNAVAILABLE,
    APP_HOSTS_WARNING_REBUILD_NOT_APPLICABLE,
    APP_HOSTS_WARNING_TLS_DISABLED,
    AppHostsService,
    appHostUrl,
    appUrlScheme,
    normaliseHost,
    normaliseTlsMode,
    sameHost,
    type AppHostsDeploymentView,
    type AppHostsDomainRow,
    type AppHostsRebuildAnswer,
    type AppHostsRuntimeStateView,
    type AppHostsWorkView,
    type AppIngressReconcileOpPayload,
} from '../app-hosts.service';

/* -------------------------------------------------------------------------- *
 * Fakes — one per seam, each recording what it was asked
 * -------------------------------------------------------------------------- */

beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

class FakeStateStore {
    row: AppHostsRuntimeStateView | null = null;
    readonly pendingWrites: Array<{ workId: string; buildId: string | null }> = [];
    readonly reads: string[] = [];
    throwOnRead = false;

    async getOrCreate(workId: string): Promise<AppHostsRuntimeStateView | null> {
        this.reads.push(workId);
        if (this.throwOnRead) throw new Error('state store unavailable');

        return this.row;
    }

    async setPendingDomainRebuildBuildId(workId: string, buildId: string | null): Promise<void> {
        this.pendingWrites.push({ workId, buildId });
    }
}

class FakeDomainStore {
    rows: AppHostsDomainRow[] = [];
    readonly reads: string[] = [];

    async findByWork(workId: string): Promise<readonly AppHostsDomainRow[]> {
        this.reads.push(workId);

        return this.rows;
    }
}

class FakeWorkStore {
    work: AppHostsWorkView | null = null;
    throwOnRead = false;

    async findById(): Promise<AppHostsWorkView | null> {
        if (this.throwOnRead) throw new Error('work store unavailable');

        return this.work;
    }
}

class FakeDeploymentStore {
    rows = new Map<string, AppHostsDeploymentView>();

    async findById(deploymentId: string): Promise<AppHostsDeploymentView | null> {
        return this.rows.get(deploymentId) ?? null;
    }
}

class FakeDeployRequester {
    readonly calls: Array<Record<string, unknown>> = [];
    answer: Record<string, unknown> | null = {
        status: 'accepted',
        deploymentId: 'deployment-1',
        code: null,
        unmet: [],
    };

    async request(request: Record<string, unknown>): Promise<Record<string, unknown> | null> {
        this.calls.push(request);

        return this.answer;
    }
}

class FakeRebuildRequester {
    readonly calls: Array<{ workId: string; opts: { userId?: string | null } }> = [];
    answer: AppHostsRebuildAnswer | null = {
        status: 'queued',
        build: { id: 'build-9', status: 'queued' },
        deduped: false,
    };

    async requestRebuild(
        workId: string,
        opts: { userId?: string | null },
    ): Promise<AppHostsRebuildAnswer | null> {
        this.calls.push({ workId, opts });

        return this.answer;
    }
}

class FakeOpDispatcher {
    readonly calls: AppIngressReconcileOpPayload[] = [];
    enabled = true;
    resolved: unknown = undefined;
    failWith: Error | null = null;

    async dispatchAppClusterOp(payload: AppIngressReconcileOpPayload): Promise<string | null> {
        this.calls.push(payload);
        if (this.failWith) throw this.failWith;

        return 'run-id';
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    resolve(): unknown {
        return this.resolved === undefined ? this : this.resolved;
    }
}

class FakeSpecSource {
    snapshot: AppDeploySpecSnapshot = {
        status: 'valid',
        spec: {
            domains: { onChange: 'restart' },
            build: { strategy: 'dockerfile' },
        } as AppDeploySpecSnapshot['spec'],
    };
    throwOnRead = false;

    async getEffectiveSpec(): Promise<AppDeploySpecSnapshot | null> {
        if (this.throwOnRead) throw new Error('spec unavailable');

        return this.snapshot;
    }
}

interface Harness {
    service: AppHostsService;
    states: FakeStateStore;
    domains: FakeDomainStore;
    works: FakeWorkStore;
    deployments: FakeDeploymentStore;
    deploys: FakeDeployRequester;
    builds: FakeRebuildRequester;
    ops: FakeOpDispatcher;
    specs: FakeSpecSource;
}

function harness(overrides: { appsDomain?: string | null } = {}): Harness {
    const states = new FakeStateStore();
    const domains = new FakeDomainStore();
    const works = new FakeWorkStore();
    const deployments = new FakeDeploymentStore();
    const deploys = new FakeDeployRequester();
    const builds = new FakeRebuildRequester();
    const ops = new FakeOpDispatcher();
    const specs = new FakeSpecSource();

    states.row = {
        target: 'your-cluster',
        targetSettings: { tls: 'cert-manager', managedSubdomain: true, primaryDomain: null },
    };
    works.work = { id: 'work-1', kind: 'app', slug: 'cal-diy', managedSubdomain: 'cal-diy' };

    const service = new AppHostsService(
        states,
        domains,
        works,
        deployments,
        deploys,
        builds,
        ops,
        {
            getDomain: () =>
                overrides.appsDomain === undefined ? 'ever.works' : overrides.appsDomain,
        },
        specs,
    );

    return { service, states, domains, works, deployments, deploys, builds, ops, specs };
}

/* -------------------------------------------------------------------------- *
 * §4.11:621-626 — the URL scheme table
 * -------------------------------------------------------------------------- */

describe('appUrlScheme (APW-06 T26, plan §4.11:621-626)', () => {
    it('answers the plan’s four TLS rows, and `external` is the one asymmetric row', () => {
        // cert-manager → https for every host (§4.11:622)
        expect(appUrlScheme('cert-manager', 'custom')).toBe('https');
        expect(appUrlScheme('cert-manager', 'managed')).toBe('https');

        // external → https for a custom domain, http for the managed subdomain (§4.11:623-624)
        expect(appUrlScheme('external', 'custom')).toBe('https');
        expect(appUrlScheme('external', 'managed')).toBe('http');

        // none → http (§4.11:624)
        expect(appUrlScheme('none', 'custom')).toBe('http');
        expect(appUrlScheme('none', 'managed')).toBe('http');

        // edge (Ever Works Apps) → https (§4.11:625)
        expect(appUrlScheme('edge', 'custom')).toBe('https');
        expect(appUrlScheme('edge', 'managed')).toBe('https');
    });

    it('defaults an unset or unknown mode to cert-manager, the selector’s own default', () => {
        expect(normaliseTlsMode(null)).toBe('cert-manager');
        expect(normaliseTlsMode(undefined)).toBe('cert-manager');
        expect(normaliseTlsMode('')).toBe('cert-manager');
        expect(normaliseTlsMode('nonsense')).toBe('cert-manager');
        expect(normaliseTlsMode(' EXTERNAL ')).toBe('external');
        expect(appUrlScheme(null, 'managed')).toBe('https');
    });

    it('builds one URL from a host and the scheme its kind earns', () => {
        expect(appHostUrl('cal.example.com', 'external', 'custom')).toBe('https://cal.example.com');
        expect(appHostUrl('cal-diy.ever.works', 'external', 'managed')).toBe(
            'http://cal-diy.ever.works',
        );
        expect(appHostUrl(null, 'cert-manager', 'managed')).toBeNull();
        expect(appHostUrl('   ', 'cert-manager', 'managed')).toBeNull();
    });

    it('compares hosts case-insensitively and without a trailing dot', () => {
        expect(sameHost('Cal.Example.COM.', 'cal.example.com')).toBe(true);
        expect(sameHost('cal.example.com', 'other.example.com')).toBe(false);
        expect(normaliseHost('  Cal.Example.COM.  ')).toBe('cal.example.com');
    });
});

/* -------------------------------------------------------------------------- *
 * §8.1 — the host set
 * -------------------------------------------------------------------------- */

describe('AppHostsService.resolveHosts (APW-06 T26, plan §8.1:1097-1104)', () => {
    it('never renders an unverified row — FR-39’s "only verified domains are published"', async () => {
        const h = harness();
        h.domains.rows = [
            { domain: 'verified.example.com', verified: true },
            { domain: 'pending.example.com', verified: false },
            { domain: 'null-verified.example.com', verified: null },
        ];
        h.states.row = {
            target: 'your-cluster',
            targetSettings: { tls: 'cert-manager', managedSubdomain: false, primaryDomain: null },
        };

        const hosts = await h.service.resolveHosts('work-1');

        expect(hosts?.extra).toEqual(['verified.example.com']);
        expect(hosts?.extra).not.toContain('pending.example.com');
        expect(hosts?.extra).not.toContain('null-verified.example.com');
        expect(hosts?.previous).toEqual([]);
    });

    it('puts the verified custom domain the owner marked primary first', async () => {
        const h = harness();
        h.domains.rows = [
            { domain: 'primary.example.com', verified: true },
            { domain: 'other.example.com', verified: true },
        ];
        h.states.row = {
            target: 'your-cluster',
            targetSettings: {
                tls: 'cert-manager',
                managedSubdomain: true,
                primaryDomain: 'Primary.Example.com.',
            },
        };

        const hosts = await h.service.resolveHosts('work-1');

        expect(hosts?.primary).toBe('primary.example.com');
        // `extra` is every verified row **except** the primary, plus the managed subdomain.
        expect(hosts?.extra).toEqual(['other.example.com', 'cal-diy.ever.works']);
        expect(hosts?.primaryUrl).toBe('https://primary.example.com');
    });

    it('falls through to the managed subdomain when the marked primary is not verified', async () => {
        const h = harness();
        h.domains.rows = [
            { domain: 'primary.example.com', verified: false },
            { domain: 'other.example.com', verified: true },
        ];
        h.states.row = {
            target: 'your-cluster',
            targetSettings: {
                tls: 'cert-manager',
                managedSubdomain: true,
                primaryDomain: 'primary.example.com',
            },
        };

        const hosts = await h.service.resolveHosts('work-1');

        // §8.1:1102 — an unverified row is never rendered, so it is not the primary either.
        expect(hosts?.primary).toBe('cal-diy.ever.works');
        expect(hosts?.extra).toEqual(['other.example.com']);
    });

    it('answers a null primary when no managed label was allocated — never a synthesised slug', async () => {
        const h = harness();
        h.works.work = { id: 'work-1', kind: 'app', slug: 'cal-diy', managedSubdomain: null };
        h.states.row = {
            target: 'your-cluster',
            targetSettings: { tls: 'cert-manager', managedSubdomain: true, primaryDomain: null },
        };

        const hosts = await h.service.resolveHosts('work-1');

        expect(hosts?.primary).toBeNull();
        expect(hosts?.extra).toEqual([]);
        expect(hosts?.primaryUrl).toBeNull();
    });

    it('answers a null primary when the apps apex does not resolve (§8.3’s getDomain() === null)', async () => {
        const h = harness({ appsDomain: null });
        h.states.row = {
            target: 'your-cluster',
            targetSettings: { tls: 'cert-manager', managedSubdomain: true, primaryDomain: null },
        };

        const hosts = await h.service.resolveHosts('work-1');

        expect(hosts?.primary).toBeNull();
        // Custom domains keep working — that is §8.3:1138-1140’s whole point: an apex that fails
        // validation "disables the managed subdomain only".
        h.domains.rows = [{ domain: 'custom.example.com', verified: true }];
        h.states.row = {
            target: 'your-cluster',
            targetSettings: {
                tls: 'cert-manager',
                managedSubdomain: true,
                primaryDomain: 'custom.example.com',
            },
        };
        expect((await h.service.resolveHosts('work-1'))?.primary).toBe('custom.example.com');
    });

    it('omits the managed subdomain when the target setting switched it off', async () => {
        const h = harness();
        h.states.row = {
            target: 'your-cluster',
            targetSettings: { tls: 'cert-manager', managedSubdomain: false, primaryDomain: null },
        };

        expect((await h.service.resolveHosts('work-1'))?.primary).toBeNull();
    });

    it('carries `previous` only while a rebuild Deployment is pending (§8.1:1103-1104)', async () => {
        const h = harness();
        h.domains.rows = [{ domain: 'new.example.com', verified: true }];
        h.states.row = {
            target: 'your-cluster',
            currentDeploymentId: 'deployment-1',
            pendingDomainRebuildBuildId: null,
            targetSettings: { tls: 'cert-manager', managedSubdomain: true, primaryDomain: null },
        };
        h.deployments.rows.set('deployment-1', {
            id: 'deployment-1',
            appRender: { hosts: { primary: 'old.example.com', extra: ['gone.example.com'] } },
        });

        // No pending rebuild ⇒ the ingress has already dropped them.
        expect((await h.service.resolveHosts('work-1'))?.previous).toEqual([]);

        h.states.row = { ...h.states.row, pendingDomainRebuildBuildId: 'build-9' };
        expect((await h.service.resolveHosts('work-1'))?.previous).toEqual([
            'old.example.com',
            'gone.example.com',
        ]);

        // A host that is still published is not "previous".
        h.domains.rows = [
            { domain: 'new.example.com', verified: true },
            { domain: 'old.example.com', verified: true },
        ];
        expect((await h.service.resolveHosts('work-1'))?.previous).toEqual(['gone.example.com']);
    });

    it('warns `tls_disabled` when TLS is off, and never refuses the Deployment', async () => {
        const h = harness();
        h.states.row = {
            target: 'your-cluster',
            targetSettings: { tls: 'none', managedSubdomain: true, primaryDomain: null },
        };

        const resolved = await h.service.resolveHost('work-1');

        expect(resolved?.primary).toBe('cal-diy.ever.works');
        expect(resolved?.primaryUrl).toBe('http://cal-diy.ever.works');
        expect(resolved?.warnings.map((warning) => warning.code)).toEqual([
            APP_HOSTS_WARNING_TLS_DISABLED,
        ]);
    });

    it('answers null only when the Work itself cannot be read', async () => {
        const h = harness();
        h.works.work = null;
        expect(await h.service.resolveHosts('work-1')).toBeNull();
        expect(await h.service.primaryHost('work-1')).toBeNull();
        expect(await h.service.primary('work-1')).toBeNull();

        h.works.work = { id: 'work-1', kind: 'app', managedSubdomain: 'cal-diy' };
        h.works.throwOnRead = true;
        expect(await h.service.resolveHosts('work-1')).toBeNull();
    });

    it('publishes the managed host alone when the state or the domain store cannot be read', async () => {
        const h = harness();
        h.domains.rows = [{ domain: 'custom.example.com', verified: true }];
        h.states.throwOnRead = true;

        const hosts = await h.service.resolveHosts('work-1');

        // No TLS setting and no readable `primaryDomain` ⇒ the managed host is the primary, and the
        // verified custom domain is still published as an `extra` (§8.1:1102).
        expect(hosts?.primary).toBe('cal-diy.ever.works');
        expect(hosts?.extra).toEqual(['custom.example.com']);
    });

    it('implements APW-11’s `primary` port as §8.1’s primary', async () => {
        const h = harness();
        h.domains.rows = [{ domain: 'custom.example.com', verified: true }];
        h.states.row = {
            target: 'your-cluster',
            targetSettings: {
                tls: 'cert-manager',
                managedSubdomain: true,
                primaryDomain: 'custom.example.com',
            },
        };

        expect(await h.service.primary('work-1')).toBe('custom.example.com');
        expect(await h.service.primaryHost('work-1')).toBe('custom.example.com');
    });
});

/* -------------------------------------------------------------------------- *
 * §8.2 — `domains.onChange`
 * -------------------------------------------------------------------------- */

describe('AppHostsService.onPrimaryChanged (APW-06 T26, plan §8.2:1106-1118)', () => {
    it('`restart` requests a Deployment of the current Build with trigger `domain-change`', async () => {
        const h = harness();
        h.states.row = {
            target: 'your-cluster',
            currentDeploymentId: 'deployment-7',
            targetSettings: {
                tls: 'cert-manager',
                managedSubdomain: true,
                primaryDomain: 'old.example.com',
            },
        };
        h.deployments.rows.set('deployment-7', { id: 'deployment-7', buildId: 'build-3' });

        const result = await h.service.onPrimaryChanged('work-1', { userId: 'user-1' });

        expect(result.status).toBe('restart-requested');
        expect(result.mode).toBe('restart');
        expect(result.deploymentId).toBe('deployment-1');
        // §8.2:1109 — "a Deployment of `currentDeployment.buildId`".
        expect(h.deploys.calls).toEqual([
            {
                workId: 'work-1',
                userId: 'user-1',
                trigger: 'domain-change',
                buildId: 'build-3',
                specCommitSha: null,
            },
        ]);
        // No rebuild was asked for, and no marker was stored.
        expect(h.builds.calls).toEqual([]);
        expect(h.states.pendingWrites).toEqual([]);
        // FR-38’s "the previous address stays published".
        expect(result.publishedPrimary).toBe('old.example.com');
    });

    it('reads the policy from the App spec when the caller names none (§8.2:1110)', async () => {
        const h = harness();
        h.specs.snapshot = {
            status: 'valid',
            spec: {
                domains: { onChange: 'rebuild' },
                build: { strategy: 'dockerfile' },
            } as AppDeploySpecSnapshot['spec'],
        };

        const result = await h.service.onPrimaryChanged('work-1');

        expect(result.mode).toBe('rebuild');
        expect(h.builds.calls).toHaveLength(1);
    });

    it('`rebuild` calls `requestRebuild` and stores the id — also when `deduped: true`', async () => {
        const h = harness();
        h.builds.answer = {
            status: 'queued',
            build: { id: 'build-42', status: 'queued' },
            deduped: true,
        };

        const result = await h.service.onPrimaryChanged('work-1', {
            userId: 'user-1',
            mode: 'rebuild',
        });

        expect(result.status).toBe('rebuild-requested');
        expect(result.buildId).toBe('build-42');
        expect(result.pendingDomainRebuildBuildId).toBe('build-42');
        expect(h.builds.calls).toEqual([{ workId: 'work-1', opts: { userId: 'user-1' } }]);
        // §8.2:1112-1114 — the marker is written for the deduped answer too.
        expect(h.states.pendingWrites).toEqual([{ workId: 'work-1', buildId: 'build-42' }]);
        // A rebuild requests no Deployment of its own: the Build's success does that (FR-33).
        expect(h.deploys.calls).toEqual([]);
    });

    it('a rate-limited rebuild stores nothing and requests no Deployment (ACC-06-26)', async () => {
        const h = harness();
        h.builds.answer = { code: APP_HOSTS_CODE_REBUILD_RATE_LIMITED, message: 'too soon' };

        const result = await h.service.onPrimaryChanged('work-1', { mode: 'rebuild' });

        expect(result.status).toBe('refused');
        expect(result.code).toBe(APP_HOSTS_CODE_REBUILD_RATE_LIMITED);
        expect(result.reason).toBe('too soon');
        expect(h.states.pendingWrites).toEqual([]);
        expect(h.deploys.calls).toEqual([]);
        expect(result.buildId).toBeNull();
    });

    it('a blocked Build stores nothing and requests no Deployment (ACC-06-26)', async () => {
        const h = harness();
        h.builds.answer = { status: 'blocked', build: { id: 'build-5', status: 'blocked' } };

        const result = await h.service.onPrimaryChanged('work-1', { mode: 'rebuild' });

        expect(result.status).toBe('refused');
        expect(result.code).toBe(APP_HOSTS_CODE_REBUILD_BLOCKED);
        expect(h.states.pendingWrites).toEqual([]);
        expect(h.deploys.calls).toEqual([]);
    });

    it('a rebuild with no Builds service refuses rather than silently restarting', async () => {
        const states = new FakeStateStore();
        states.row = { target: 'your-cluster', targetSettings: { tls: 'cert-manager' } };
        const service = new AppHostsService(states, undefined, undefined, undefined, undefined);

        const result = await service.onPrimaryChanged('work-1', { mode: 'rebuild' });

        expect(result.status).toBe('refused');
        expect(result.code).toBe(APP_HOSTS_CODE_REBUILD_UNAVAILABLE);
        expect(result.mode).toBe('rebuild');
    });

    it('a refused Deployment keeps the saved primary and requests nothing else', async () => {
        const h = harness();
        h.deploys.answer = {
            status: 'refused',
            code: 'APP_DEPLOY_IN_PROGRESS',
            unmet: [{ code: 'deploy_in_progress', message: 'Another Deployment is running.' }],
        };
        h.states.row = {
            target: 'your-cluster',
            targetSettings: { tls: 'cert-manager', primaryDomain: 'old.example.com' },
        };

        const result = await h.service.onPrimaryChanged('work-1');

        expect(result.status).toBe('refused');
        expect(result.code).toBe('APP_DEPLOY_IN_PROGRESS');
        expect(result.reason).toBe('Another Deployment is running.');
        expect(result.deploymentId).toBeNull();
        expect(result.publishedPrimary).toBe('old.example.com');
    });

    it('under `build.strategy: image` a rebuild is a restart with `rebuild_not_applicable`', async () => {
        const h = harness();
        h.specs.snapshot = {
            status: 'valid',
            spec: {
                domains: { onChange: 'rebuild' },
                build: { strategy: 'image' },
            } as AppDeploySpecSnapshot['spec'],
        };

        const result = await h.service.onPrimaryChanged('work-1');

        expect(result.mode).toBe('restart');
        expect(result.status).toBe('restart-requested');
        expect(result.warnings.map((warning) => warning.code)).toEqual([
            APP_HOSTS_WARNING_REBUILD_NOT_APPLICABLE,
        ]);
        // The Build is never asked for: there is none to rebuild (§5.8:892-894).
        expect(h.builds.calls).toEqual([]);
        expect(h.deploys.calls).toHaveLength(1);
    });

    it('answers `work_not_found` for a missing Work rather than reading anything', async () => {
        const h = harness();

        const result = await h.service.onPrimaryChanged('');

        expect(result.status).toBe('refused');
        expect(result.code).toBe('work_not_found');
        expect(h.states.reads).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * §8.2:1117-1118 — the non-primary reconcile
 * -------------------------------------------------------------------------- */

describe('AppHostsService.onHostsChanged (APW-06 T26, ACC-06-25)', () => {
    it('dispatches `ingress-reconcile` and requests no Deployment', async () => {
        const h = harness();

        const result = await h.service.onHostsChanged('work-1', { reason: 'domain-added' });

        expect(result.status).toBe('dispatched');
        expect(result.op).toBe(APP_INGRESS_RECONCILE_OP);
        expect(result.dispatched).toBe(true);
        expect(h.ops.calls).toEqual([
            {
                op: APP_INGRESS_RECONCILE_OP,
                workId: 'work-1',
                reason: 'domain-added',
                requestId: null,
            },
        ]);
        // The second half of ACC-06-25: "no Deployment requested".
        expect(h.deploys.calls).toEqual([]);
        expect(h.builds.calls).toEqual([]);
    });

    it('refuses by name when no isolated worker is bound in this process', async () => {
        const h = harness();
        h.ops.enabled = false;

        const result = await h.service.onHostsChanged('work-1');

        expect(result.status).toBe('refused');
        expect(result.code).toBe(APP_HOSTS_CODE_RECONCILE_UNAVAILABLE);
        expect(result.dispatched).toBe(false);
        expect(h.ops.calls).toEqual([]);
    });

    it('refuses by name when the dispatch itself throws', async () => {
        const h = harness();
        h.ops.failWith = new Error('no runner');

        const result = await h.service.onHostsChanged('work-1');

        expect(result.status).toBe('refused');
        expect(result.code).toBe(APP_HOSTS_CODE_RECONCILE_UNAVAILABLE);
        expect(result.reason).toContain('no runner');
    });
});
