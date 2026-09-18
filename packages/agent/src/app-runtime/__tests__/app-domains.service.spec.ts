/**
 * APW-06 T26 (half two) — `AppDomainsService` and the two pure helpers (plan §8.4; spec FR-38,
 * FR-39; ACC-06-25, ACC-06-26, ACC-06-39).
 *
 * T26's Test line (`tasks.md:478-479`) names one case for this file — "DNS guidance `A` for an IP
 * and `CNAME` for a hostname" — and §8.4:1152-1157 is the rest of it: "rows stored as today; verify
 * uses `verifyDomainResolution(domain, runtimeState.ingressAddress)`; success → `updateVerified` +
 * reconcile/onChange; remove → row delete + reconcile".
 *
 * The suite pins the parts a mapping assertion would miss:
 *
 * - **the address comes from the runtime state**, which §6.3's `checkAppCluster` records *before*
 *   the first Deployment (GAP-09) — so a domain can be verified on a Work that has never deployed,
 *   and a Work whose cluster has reported no address gets `no_ingress_address` rather than a
 *   refusal;
 * - **a failed check writes nothing**: a transient DNS timeout must not un-verify a domain that is
 *   already published, and it must not dispatch a reconcile for a change that did not happen;
 * - **verify and remove dispatch the reconcile, and request no Deployment** — ACC-06-25's two
 *   halves — while a change that moves the **primary** additionally asks §8.2's question;
 * - **nothing here reaches a repository** (ACC-06-39): the only collaborators are the domain store,
 *   the runtime state and the hosts service.
 */

import { Logger } from '@nestjs/common';

import {
    AppDomainsService,
    buildDnsGuidance,
    ingressTarget,
    type AppCustomDomainRow,
    type AppCustomDomainStore,
    type AppDomainsStateStore,
    type AppIngressAddress,
} from '../app-domains.service';
import { AppHostsService, type AppHostsRuntimeStateView } from '../app-hosts.service';

/* -------------------------------------------------------------------------- *
 * Fakes
 * -------------------------------------------------------------------------- */

beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

class FakeDomainStore implements AppCustomDomainStore {
    rows: AppCustomDomainRow[] = [];
    readonly added: Array<{ workId: string; domain: string }> = [];
    readonly removed: Array<{ workId: string; domain: string }> = [];
    readonly verifications: Array<{ workId: string; domain: string; verified: boolean }> = [];
    removeAnswer = true;

    async findByWork(workId: string): Promise<readonly AppCustomDomainRow[]> {
        return this.rows.filter((row) => (row as { workId?: string }).workId === undefined);
    }

    async addDomain(workId: string, domain: string): Promise<AppCustomDomainRow | null> {
        this.added.push({ workId, domain });
        const row: AppCustomDomainRow = { domain, verified: false };
        this.rows.push(row);

        return row;
    }

    async removeDomain(workId: string, domain: string): Promise<boolean> {
        this.removed.push({ workId, domain });

        return this.removeAnswer;
    }

    async updateVerified(workId: string, domain: string, verified: boolean): Promise<void> {
        this.verifications.push({ workId, domain, verified });
    }
}

class FakeStateStore implements AppDomainsStateStore {
    row: AppHostsRuntimeStateView | null = null;

    async getOrCreate(): Promise<AppHostsRuntimeStateView | null> {
        return this.row;
    }
}

class FakeHosts {
    readonly primaryChanges: Array<{ workId: string; userId?: string | null }> = [];
    readonly reconciles: Array<{ workId: string; reason: string }> = [];
    primaryAnswer: Record<string, unknown> = { status: 'restart-requested', mode: 'restart' };
    reconcileAnswer: Record<string, unknown> = { status: 'dispatched', dispatched: true };

    async onPrimaryChanged(
        workId: string,
        opts: { userId?: string | null } = {},
    ): Promise<Record<string, unknown>> {
        this.primaryChanges.push({ workId, userId: opts.userId ?? null });

        return this.primaryAnswer;
    }

    async onHostsChanged(
        workId: string,
        opts: { reason?: string | null } = {},
    ): Promise<Record<string, unknown>> {
        this.reconciles.push({ workId, reason: String(opts.reason ?? '') });

        return this.reconcileAnswer;
    }
}

/** The service with DNS pinned — the seam T22 uses for its own resolver. */
class TestableDomains extends AppDomainsService {
    addresses: string[] = [];
    throwOnResolve = false;
    readonly lookups: Array<{ domain: string; kind: string | null }> = [];

    protected async resolveAddresses(
        domain: string,
        expectedKind: 'A' | 'CNAME' | null,
    ): Promise<string[]> {
        this.lookups.push({ domain, kind: expectedKind });
        if (this.throwOnResolve) throw new Error('getaddrinfo ENOTFOUND');

        return this.addresses;
    }
}

interface Harness {
    service: TestableDomains;
    domains: FakeDomainStore;
    states: FakeStateStore;
    hosts: FakeHosts;
}

function harness(): Harness {
    const domains = new FakeDomainStore();
    const states = new FakeStateStore();
    const hosts = new FakeHosts();
    const service = new TestableDomains(domains, states, hosts as unknown as AppHostsService);

    states.row = {
        target: 'your-cluster',
        ingressAddress: { ip: '203.0.113.10', hostname: 'ingress.example.net' },
        targetSettings: { tls: 'cert-manager', primaryDomain: null },
    };

    return { service, domains, states, hosts };
}

/* -------------------------------------------------------------------------- *
 * §8.4:1157 / FR-39 — the DNS guidance
 * -------------------------------------------------------------------------- */

describe('buildDnsGuidance (APW-06 T26, plan §8.4:1157)', () => {
    it('answers an `A` record for an IP', () => {
        const guidance = buildDnsGuidance('app.example.com', '203.0.113.10');

        expect(guidance).toEqual([
            {
                type: 'A',
                domain: 'app.example.com',
                value: '203.0.113.10',
                reason: "Point app.example.com at the address your cluster's ingress reports.",
            },
        ]);
    });

    it('answers a `CNAME` for a hostname', () => {
        const guidance = buildDnsGuidance('App.Example.com.', 'ingress.example.net');

        expect(guidance).toHaveLength(1);
        expect(guidance?.[0].type).toBe('CNAME');
        expect(guidance?.[0].value).toBe('ingress.example.net');
        // The domain is canonicalised, so the member pastes a name that matches the stored row.
        expect(guidance?.[0].domain).toBe('app.example.com');
    });

    it('answers nothing when there is no address or no name to point', () => {
        expect(buildDnsGuidance('app.example.com', null)).toBeNull();
        expect(buildDnsGuidance('app.example.com', '   ')).toBeNull();
        expect(buildDnsGuidance('   ', '203.0.113.10')).toBeNull();
    });

    it('prefers the ingress IP over its hostname (§8.4’s `ip ?? hostname`)', () => {
        expect(ingressTarget({ ip: '203.0.113.10', hostname: 'ingress.example.net' })).toBe(
            '203.0.113.10',
        );
        expect(ingressTarget({ ip: null, hostname: 'ingress.example.net' })).toBe(
            'ingress.example.net',
        );
        expect(ingressTarget({ ip: '  ', hostname: 'ingress.example.net' })).toBe(
            'ingress.example.net',
        );
        expect(ingressTarget(null)).toBeNull();
    });
});

/* -------------------------------------------------------------------------- *
 * §8.4:1156 — verifyDomainResolution
 * -------------------------------------------------------------------------- */

describe('AppDomainsService.verifyDomainResolution (APW-06 T26, plan §8.4)', () => {
    it('verifies a domain whose own records name the ingress address', async () => {
        const h = harness();
        h.service.addresses = ['203.0.113.10'];

        const result = await h.service.verifyDomainResolution('app.example.com', {
            ip: '203.0.113.10',
        });

        expect(result.status).toBe('verified');
        expect(result.verified).toBe(true);
        expect(result.expectedKind).toBe('A');
        expect(result.addresses).toEqual(['203.0.113.10']);
        expect(h.service.lookups).toEqual([{ domain: 'app.example.com', kind: 'A' }]);
    });

    it('reports a mismatch, naming both addresses', async () => {
        const h = harness();
        h.service.addresses = ['198.51.100.7'];

        const result = await h.service.verifyDomainResolution('app.example.com', {
            ip: '203.0.113.10',
        });

        expect(result.status).toBe('mismatch');
        expect(result.verified).toBe(false);
        expect(result.reason).toContain('198.51.100.7');
        expect(result.reason).toContain('203.0.113.10');
    });

    it('reports `unresolved` for a domain with no record, and for a resolver error', async () => {
        const h = harness();
        h.service.addresses = [];

        expect(
            (await h.service.verifyDomainResolution('app.example.com', { ip: '203.0.113.10' }))
                .status,
        ).toBe('unresolved');

        h.service.throwOnResolve = true;
        const failed = await h.service.verifyDomainResolution('app.example.com', {
            ip: '203.0.113.10',
        });

        expect(failed.status).toBe('unresolved');
        expect(failed.reason).toContain('ENOTFOUND');
    });

    it('refuses to judge when the cluster reported no address (GAP-09’s `no_ingress_address`)', async () => {
        const h = harness();

        const result = await h.service.verifyDomainResolution('app.example.com', null);

        expect(result.status).toBe('no_ingress_address');
        expect(result.verified).toBe(false);
        // Nothing was looked up: there is no expectation to compare against.
        expect(h.service.lookups).toEqual([]);
    });

    it('reads a CNAME expectation as a hostname and looks up CNAMEs', async () => {
        const h = harness();
        h.service.addresses = ['ingress.example.net'];

        const result = await h.service.verifyDomainResolution('app.example.com', {
            hostname: 'ingress.example.net',
        });

        expect(result.status).toBe('verified');
        expect(result.expectedKind).toBe('CNAME');
        expect(h.service.lookups).toEqual([{ domain: 'app.example.com', kind: 'CNAME' }]);
    });

    it('reads the address from `runtimeState.ingressAddress`, which §6.3 records before the first Deployment', async () => {
        const h = harness();
        h.service.addresses = ['203.0.113.10'];
        // A Work with a recorded address and **no** Deployment at all: `currentDeploymentId` unset.
        h.states.row = {
            target: 'your-cluster',
            currentDeploymentId: null,
            ingressAddress: { ip: '203.0.113.10' },
            targetSettings: { tls: 'cert-manager' },
        };

        const outcome = await h.service.verifyDomain('app.example.com', { workId: 'work-1' });

        expect(outcome.verified).toBe(true);
        expect(h.domains.verifications).toEqual([
            { workId: 'work-1', domain: 'app.example.com', verified: true },
        ]);
    });
});

/* -------------------------------------------------------------------------- *
 * §8.4 — verify, add, remove, getDomains
 * -------------------------------------------------------------------------- */

describe('AppDomainsService.verifyDomain (APW-06 T26, ACC-06-25)', () => {
    it('stores the verification and dispatches `ingress-reconcile`, requesting no Deployment', async () => {
        const h = harness();
        h.service.addresses = ['203.0.113.10'];

        const outcome = await h.service.verifyDomain('app.example.com', { workId: 'work-1' });

        expect(outcome.verified).toBe(true);
        expect(outcome.domain).toEqual({ name: 'app.example.com', verified: true });
        expect(h.domains.verifications).toEqual([
            { workId: 'work-1', domain: 'app.example.com', verified: true },
        ]);
        expect(h.hosts.reconciles).toEqual([{ workId: 'work-1', reason: 'domain-verified' }]);
        // Not the primary, so §8.2’s question is not asked — ACC-06-25’s second half.
        expect(h.hosts.primaryChanges).toEqual([]);
    });

    it('stores nothing and dispatches nothing when the check fails', async () => {
        const h = harness();
        h.service.addresses = ['198.51.100.7'];
        h.domains.rows = [{ domain: 'app.example.com', verified: true }];

        const outcome = await h.service.verifyDomain('app.example.com', { workId: 'work-1' });

        expect(outcome.verified).toBe(false);
        // A transient DNS answer must not un-publish a domain that already resolved.
        expect(h.domains.verifications).toEqual([]);
        expect(h.hosts.reconciles).toEqual([]);
        // The row’s own verified state is echoed, and the guidance says what to fix.
        expect(outcome.domain.verified).toBe(true);
        expect(outcome.domain.verification?.[0].value).toBe('203.0.113.10');
    });

    it('asks §8.2’s question when the verified domain is the saved primary', async () => {
        const h = harness();
        h.service.addresses = ['203.0.113.10'];
        h.states.row = {
            target: 'your-cluster',
            ingressAddress: { ip: '203.0.113.10' },
            targetSettings: { tls: 'cert-manager', primaryDomain: 'app.example.com' },
        };

        const outcome = await h.service.verifyDomain('app.example.com', {
            workId: 'work-1',
            userId: 'user-1',
        });

        expect(outcome.primaryChange).toEqual({ status: 'restart-requested', mode: 'restart' });
        expect(h.hosts.primaryChanges).toEqual([{ workId: 'work-1', userId: 'user-1' }]);
    });
});

describe('AppDomainsService.addDomain (APW-06 T26, FR-39)', () => {
    it('stores the row unverified and answers the DNS guidance', async () => {
        const h = harness();

        const result = await h.service.addDomain('App.Example.com.', { workId: 'work-1' });

        expect(h.domains.added).toEqual([{ workId: 'work-1', domain: 'app.example.com' }]);
        expect(result.verified).toBe(false);
        expect(result.domain.name).toBe('app.example.com');
        expect(result.domain.verification?.[0]).toMatchObject({
            type: 'A',
            value: '203.0.113.10',
        });
        // Adding publishes nothing yet, so nothing is reconciled.
        expect(h.hosts.reconciles).toEqual([]);
    });

    it('reuses an existing row rather than adding a second one', async () => {
        const h = harness();
        h.domains.rows = [{ domain: 'app.example.com', verified: true }];

        const result = await h.service.addDomain('app.example.com', { workId: 'work-1' });

        expect(h.domains.added).toEqual([]);
        expect(result.verified).toBe(true);
        expect(result.domain.verification).toBeUndefined();
    });
});

describe('AppDomainsService.removeDomain (APW-06 T26, §8.4)', () => {
    it('deletes the row and dispatches `ingress-reconcile`', async () => {
        const h = harness();

        const outcome = await h.service.removeDomain('app.example.com', { workId: 'work-1' });

        expect(outcome.removed).toBe(true);
        expect(h.domains.removed).toEqual([{ workId: 'work-1', domain: 'app.example.com' }]);
        expect(h.hosts.reconciles).toEqual([{ workId: 'work-1', reason: 'domain-removed' }]);
        expect(h.hosts.primaryChanges).toEqual([]);
    });

    it('asks §8.2’s question when the removed domain was the primary', async () => {
        const h = harness();
        h.states.row = {
            target: 'your-cluster',
            ingressAddress: { ip: '203.0.113.10' },
            targetSettings: { tls: 'cert-manager', primaryDomain: 'app.example.com' },
        };

        const outcome = await h.service.removeDomain('app.example.com', { workId: 'work-1' });

        expect(outcome.primaryChange).toEqual({ status: 'restart-requested', mode: 'restart' });
        expect(h.hosts.primaryChanges).toEqual([{ workId: 'work-1', userId: null }]);
    });

    it('reconciles nothing when no row was stored under that name', async () => {
        const h = harness();
        h.domains.removeAnswer = false;

        const outcome = await h.service.removeDomain('app.example.com', { workId: 'work-1' });

        expect(outcome.removed).toBe(false);
        expect(h.hosts.reconciles).toEqual([]);
    });
});

describe('AppDomainsService.getDomains (APW-06 T26, §8.4)', () => {
    it('answers the facade’s own `DeploymentDomain` shape, with guidance for the unverified ones', async () => {
        const h = harness();
        h.domains.rows = [
            { domain: 'verified.example.com', verified: true },
            { domain: 'pending.example.com', verified: false },
        ];

        const domains = await h.service.getDomains({ workId: 'work-1' });

        expect(domains).toEqual([
            { name: 'verified.example.com', verified: true },
            {
                name: 'pending.example.com',
                verified: false,
                verification: [
                    {
                        type: 'A',
                        domain: 'pending.example.com',
                        value: '203.0.113.10',
                        reason: expect.stringContaining('ingress reports'),
                    },
                ],
            },
        ]);
    });
});

describe('AppDomainsService — nothing reaches a repository (ACC-06-39)', () => {
    it('has exactly three collaborators: the domain rows, the runtime state and the hosts service', () => {
        // The constructor’s arity is the assertion: a fourth seam would need a fourth argument, and
        // ACC-06-39 is the rule that the license gate and the domain flow never write to a
        // repository. `AppDomainsService.length` is the declared parameter count.
        expect(AppDomainsService.length).toBe(3);
    });
});
