/**
 * APW-06 T26 (half two) — the **custom domains** service: the App branch of the existing
 * add → DNS instructions → verify → remove flow, its DNS guidance, and the resolution check that
 * decides whether a domain may be published.
 *
 * Spec: `APW-06-app-runtime/spec.md` FR-39 (`spec.md:431-433` — "Custom domains reuse the existing
 * add → DNS instructions → verify → remove flow. **Only verified domains are published.** DNS
 * instructions use the address the cluster's ingress reports: an IP gives an `A` record, a hostname
 * a `CNAME`"), FR-38 (`:426-430`, what a primary change does) and FR-41/FR-42. Plan: **§8.4**
 * (`plan.md:1152-1157` — "`DeployFacadeService.getDomains/addDomain/removeDomain/verifyDomain` and
 * `ManagedSubdomainService` gain an early `if (work.kind === 'app')` branch that delegates to
 * `AppDomainsService`: rows stored as today; verify uses
 * `verifyDomainResolution(domain, runtimeState.ingressAddress)`; success → `updateVerified` +
 * reconcile/onChange; remove → row delete + reconcile. DNS guidance uses
 * `buildDnsGuidance(domain, ip ?? hostname)`"), **§8.1** (`:1097-1104`), **§8.2**
 * (`:1106-1118`), §6.3 (`:993-1012` — `checkAppCluster` records the ingress address, GAP-09).
 * Task text: `tasks.md:466-481` (T26). Acceptance: **ACC-06-25**, **ACC-06-26**, **ACC-06-39**
 * (nothing here writes to a repository) and the GAP-09 note that the verify path reads the address
 * `checkAppCluster` recorded **before** the first Deployment.
 *
 * ## One `Symbol` for the domain rows, shared with the hosts service
 *
 * {@link APP_CUSTOM_DOMAIN_STORE} is declared in `app-hosts.service.ts` and **reused** here, with
 * the wider view this file needs ({@link AppCustomDomainStore} extends that file's
 * `AppHostsDomainStore`). Two tokens for one provider would each receive half of T17's single
 * binding. The direction of the import is deliberate: this file imports the hosts service (it
 * delegates a primary change to {@link AppHostsService.onPrimaryChanged}) and the hosts service
 * imports nothing from this one, so there is no cycle.
 *
 * ## `verifyDomainResolution` reads DNS and nothing else
 *
 * §8.4 says the verify path uses `verifyDomainResolution(domain, runtimeState.ingressAddress)`, and
 * §6.3/GAP-09 is why the address is on the runtime state at all: `checkAppCluster` records it
 * **before the first Deployment**, so a domain can be verified on a Work whose app has never
 * deployed. Three outcomes, and only the first is a success:
 *
 * - `verified` — the domain's own records name the expected address;
 * - `mismatch` — DNS answers, and none of the answers is the expected address (the owner's record
 *   still points at the old provider);
 * - `unresolved` — no record at all, or the lookup failed (NXDOMAIN, a timeout, a resolver error);
 * - `no_ingress_address` — the cluster has not reported an address, so there is nothing to compare
 *   against. This is a **refusal to judge**, not a failure: the caller retries after
 *   `cluster-check` (§6.3), and it is why the check never reports `verified` from an absent
 *   expectation.
 *
 * Resolution is a `protected` method so a spec pins every branch without touching the network —
 * the same seam T23 uses for its own clock (`app-public-smoke.service.ts`) and T22 for its
 * resolver (`app-render-input.builder.ts:1007`).
 *
 * ## What this file deliberately does not do
 *
 * It never merges custom-domain hosts into a website's ingress (`mergeCustomDomainHosts` is
 * `apps/api`'s and stays untouched — `tasks.md:481`), never writes a DNS record, never dials a
 * plugin, never touches a repository (ACC-06-39) and never allocates a managed label. The managed
 * subdomain is §8.3's `SubdomainAllocator` + `AppsDomainDnsService`, reached by the routes; this
 * service only ever answers about the custom domains a member added.
 */

import * as dns from 'node:dns';
import { isIP } from 'node:net';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { AddDomainResult, DeploymentDomain } from '@ever-works/plugin';

import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
import {
    APP_CUSTOM_DOMAIN_STORE,
    AppHostsService,
    normaliseHost,
    type AppHostsDomainRow,
    type AppHostsDomainStore,
    type AppHostsReconcileResult,
    type AppHostsRuntimeStateView,
} from './app-hosts.service';

/* -------------------------------------------------------------------------- *
 * Vocabulary this file adds
 * -------------------------------------------------------------------------- */

/** §8.4's DNS guidance record type — `A` for an address, `CNAME` for a hostname (FR-39). */
export type AppDnsRecordType = 'A' | 'CNAME';

/** The ingress address §6.3 records, as this service reads it. */
export interface AppIngressAddress {
    ip?: string | null;
    hostname?: string | null;
}

/**
 * What {@link verifyDomainResolution} concluded.
 *
 * `status` is a **string discriminant** on purpose: this package sets `strictNullChecks: false`,
 * under which a boolean or a union of object shapes does not narrow
 * (`app-deploy-preconditions.service.ts:157-163`).
 */
export interface AppDomainResolutionResult {
    /** `verified` · `mismatch` · `unresolved` · `no_ingress_address`. */
    status: string;
    /** `true` ⇔ `status === 'verified'`. Named so a caller cannot mistake the other three for it. */
    verified: boolean;
    /** The domain that was judged, canonicalised. */
    domain: string;
    /** The address that was expected — the IP, or the hostname of a `CNAME`. */
    expected: string | null;
    /** Which of the two the expectation was. */
    expectedKind: AppDnsRecordType | null;
    /** What DNS answered for the domain, in resolution order. */
    addresses: string[];
    /** A short, secret-free explanation for the member's UI. */
    reason: string | null;
}

/** The result of a verify that also moved the published hosts. */
export interface AppDomainVerifyOutcome {
    /** The row's state after the call — `DeploymentDomain`, as the facade's callers already read it. */
    domain: DeploymentDomain;
    /** `true` ⇔ the domain now resolves to this Work's ingress address. */
    verified: boolean;
    /** §8.4's "success → `updateVerified` + reconcile/onChange". `null` when nothing was published. */
    reconcile: AppHostsReconcileResult | null;
    /** Set only when the verified domain is the saved primary, so the primary changed (§8.2). */
    primaryChange: Awaited<ReturnType<AppHostsService['onPrimaryChanged']>> | null;
}

/** The result of a remove that also moved the published hosts. */
export interface AppDomainRemovalOutcome {
    /** `true` ⇔ a stored row was deleted — what `DeployFacadeService.removeDomain` answers. */
    removed: boolean;
    /** §8.4's "remove → row delete + reconcile". `null` when no row was stored under that name. */
    reconcile: AppHostsReconcileResult | null;
    /** Set only when the removed domain was the saved primary (§8.2). */
    primaryChange: Awaited<ReturnType<AppHostsService['onPrimaryChanged']>> | null;
}

/** What the facade's App branch passes through — the same options its own methods take. */
export interface AppDomainsOptions {
    workId: string;
    userId?: string | null;
}

/* -------------------------------------------------------------------------- *
 * Provisional — the wider view of the custom-domain rows (one token, two views)
 * -------------------------------------------------------------------------- */

/**
 * `WorkCustomDomainRepository` in full, as this file needs it
 * (`database/repositories/work-custom-domain.repository.ts:200-260`). The token is
 * {@link APP_CUSTOM_DOMAIN_STORE}, declared by the hosts service; the binding is
 * `{ provide: APP_CUSTOM_DOMAIN_STORE, useExisting: WorkCustomDomainRepository }`, and that one
 * provider satisfies both views.
 */
export interface AppCustomDomainStore extends AppHostsDomainStore {
    /** §8.4's "rows stored as today" — the repository's own `addDomain(workId, domain, provider?)`. */
    addDomain?(
        workId: string,
        domain: string,
        provider?: string,
    ): Promise<AppHostsDomainRow | null>;
    removeDomain?(workId: string, domain: string): Promise<boolean>;
    /** §8.4's "success → `updateVerified`". */
    updateVerified?(workId: string, domain: string, verified: boolean): Promise<void>;
}

/** One custom-domain row as this service reads it — the hosts view plus the environment. */
export interface AppCustomDomainRow extends AppHostsDomainRow {
    environment?: string | null;
    provider?: string | null;
}

/** APW-06 T17's runtime-state row, read here for the one field §8.4 names. */
export interface AppDomainsStateStore {
    getOrCreate(workId: string): Promise<AppHostsRuntimeStateView | null>;
}

/* -------------------------------------------------------------------------- *
 * Pure helpers — §8.4's DNS guidance
 * -------------------------------------------------------------------------- */

/**
 * §8.4:1157 — `buildDnsGuidance(domain, ip ?? hostname)`: "an IP gives an `A` record, a hostname a
 * `CNAME`" (FR-39, `spec.md:432-433`). `null` when there is no address to point at, which is the
 * configuration `checkAppCluster` reports as `no_ingress_address` — a guidance record with an empty
 * value would be worse than none, because the member would paste it into their zone.
 */
export function buildDnsGuidance(
    domain: string,
    target: string | null | undefined,
): DeploymentDomain['verification'] {
    const name = normaliseHost(domain);
    const value = typeof target === 'string' ? target.trim() : '';

    if (!name || !value) return null;

    const type: AppDnsRecordType = isIP(value) !== 0 ? 'A' : 'CNAME';
    const reason =
        type === 'A'
            ? `Point ${name} at the address your cluster's ingress reports.`
            : `Point ${name} at the hostname your cluster's ingress reports.`;

    return [{ type, domain: name, value, reason }];
}

/** The address §8.4 compares against, in its own order: the IP first, else the hostname. */
export function ingressTarget(address: AppIngressAddress | null | undefined): string | null {
    const ip = typeof address?.ip === 'string' ? address.ip.trim() : '';
    if (ip) return ip;

    const hostname = typeof address?.hostname === 'string' ? address.hostname.trim() : '';

    return hostname || null;
}

/* -------------------------------------------------------------------------- *
 * The service
 * -------------------------------------------------------------------------- */

/**
 * §8.4's App branch. Constructed in the API — `DeployFacadeService`'s four domain methods delegate
 * to it — and safe to construct anywhere: every collaborator is `@Optional()` and each absent one
 * has a defined answer.
 */
@Injectable()
export class AppDomainsService {
    private readonly logger = new Logger(AppDomainsService.name);

    constructor(
        @Optional()
        @Inject(APP_CUSTOM_DOMAIN_STORE)
        private readonly domains?: AppCustomDomainStore,
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly runtimeStates?: AppDomainsStateStore,
        @Optional()
        private readonly hosts?: AppHostsService,
    ) {}

    /* ---------------------------------------------------------------------- *
     * The four methods §8.4 names
     * ---------------------------------------------------------------------- */

    /**
     * §8.4's `getDomains`. "Rows stored as today" — the same `DeploymentDomain` shape the facade
     * returns for every other kind, so the route and the web need no App-specific branch.
     *
     * The one App difference is the guidance: an unverified App domain is given DNS instructions
     * built from the address the cluster reported (§8.4:1157), where the other kinds ask the
     * provider. That is the whole reason this method exists rather than being skipped.
     */
    async getDomains(options: AppDomainsOptions): Promise<DeploymentDomain[]> {
        const workId = text(options?.workId);
        if (!workId) return [];

        const rows = await this.readRows(workId);
        const address = await this.readIngressAddress(workId);

        return rows.map((row) => {
            const name = normaliseHost(row.domain);

            return {
                name,
                verified: row.verified === true,
                ...(row.verified === true
                    ? {}
                    : {
                          verification: buildDnsGuidance(name, ingressTarget(address)) ?? undefined,
                      }),
            };
        });
    }

    /**
     * §8.4's `addDomain`. A row is stored **unverified** — verification is the member's DNS change,
     * and publishing before it resolves is exactly what FR-39 forbids. Nothing is published here, so
     * no reconcile is dispatched: the guidance this returns is what the member acts on.
     */
    async addDomain(domain: string, options: AppDomainsOptions): Promise<AddDomainResult> {
        const workId = text(options?.workId);
        const name = normaliseHost(domain);

        if (!workId || !name) {
            throw new Error('An App custom domain needs both a Work and a domain name.');
        }

        const existing = await this.findRow(workId, name);
        const record = existing ?? (await this.addRow(workId, name));
        const address = await this.readIngressAddress(workId);
        const verified = record?.verified === true;

        return {
            domain: {
                name,
                verified,
                ...(verified
                    ? {}
                    : {
                          verification: buildDnsGuidance(name, ingressTarget(address)) ?? undefined,
                      }),
            },
            verified,
        };
    }

    /**
     * §8.4's `removeDomain`: "row delete + reconcile". The row goes first — a reconcile that ran
     * before the delete would re-apply the very host that was just removed — and the reconcile is
     * dispatched through §8.2:1117-1118's op, which requests **no** Deployment.
     *
     * When the removed domain was the saved primary, the primary changed by definition, so §8.2's
     * `onPrimaryChanged` runs as well: the previous address stays published until the new version is
     * live (FR-38), which is what that call arranges.
     */
    async removeDomain(
        domain: string,
        options: AppDomainsOptions,
    ): Promise<AppDomainRemovalOutcome> {
        const workId = text(options?.workId);
        const name = normaliseHost(domain);

        if (!workId || !name) return { removed: false, reconcile: null, primaryChange: null };

        const state = await this.readState(workId);
        const wasPrimary = sameHost(text(state?.targetSettings?.primaryDomain) ?? '', name);

        const removed = await this.removeRow(workId, name);

        if (!removed) {
            // Nothing was stored under that name: the facade's own answer is `false`, and a
            // reconcile for a domain nobody added would re-apply an unchanged Ingress.
            return { removed: false, reconcile: null, primaryChange: null };
        }

        const primaryChange = wasPrimary
            ? ((await this.hosts?.onPrimaryChanged(workId, { userId: options?.userId ?? null })) ??
              null)
            : null;

        return {
            removed: true,
            reconcile:
                (await this.hosts?.onHostsChanged(workId, { reason: 'domain-removed' })) ?? null,
            primaryChange,
        };
    }

    /**
     * §8.4's `verifyDomain`:
     *
     * ```
     * verify uses verifyDomainResolution(domain, runtimeState.ingressAddress)
     * success → updateVerified + reconcile/onChange
     * ```
     *
     * A failed check stores nothing and dispatches nothing: the row keeps its current `verified`
     * value rather than being written `false` on a transient DNS timeout, because an owner whose
     * record is already correct must not lose their published host to a resolver hiccup. The
     * returned `DeploymentDomain` carries the guidance again so the member sees what to fix.
     */
    async verifyDomain(
        domain: string,
        options: AppDomainsOptions,
    ): Promise<AppDomainVerifyOutcome> {
        const workId = text(options?.workId);
        const name = normaliseHost(domain);

        if (!workId || !name) {
            return {
                domain: { name, verified: false },
                verified: false,
                reconcile: null,
                primaryChange: null,
            };
        }

        const state = await this.readState(workId);
        const address = state?.ingressAddress ?? null;
        const resolution = await this.verifyDomainResolution(name, address);

        if (!resolution.verified) {
            this.logger.debug(
                `App custom domain ${name} of Work ${workId} is ${resolution.status}` +
                    `${resolution.reason ? ` (${resolution.reason})` : ''}.`,
            );

            return {
                domain: {
                    name,
                    verified: (await this.findRow(workId, name))?.verified === true,
                    verification: buildDnsGuidance(name, ingressTarget(address)) ?? undefined,
                },
                verified: false,
                reconcile: null,
                primaryChange: null,
            };
        }

        await this.updateVerified(workId, name, true);

        // §8.2:1108-1109 — the verify branch is one of the four callers of `onPrimaryChanged`.
        const isPrimary = sameHost(text(state?.targetSettings?.primaryDomain) ?? '', name);
        const primaryChange = isPrimary
            ? ((await this.hosts?.onPrimaryChanged(workId, { userId: options?.userId ?? null })) ??
              null)
            : null;

        return {
            domain: { name, verified: true },
            verified: true,
            reconcile:
                (await this.hosts?.onHostsChanged(workId, { reason: 'domain-verified' })) ?? null,
            primaryChange,
        };
    }

    /* ---------------------------------------------------------------------- *
     * §8.4's resolution check
     * ---------------------------------------------------------------------- */

    /**
     * `verifyDomainResolution(domain, runtimeState.ingressAddress)` — §8.4:1156, with the four
     * outcomes documented on {@link AppDomainResolutionResult}.
     *
     * The address is `state.ingressAddress`, which §6.3's `checkAppCluster` records **before the
     * first Deployment** (GAP-09) — so a member can verify DNS while the app is still building, and
     * a Work that has never had a cluster check answers `no_ingress_address` rather than refusing
     * the domain outright.
     */
    async verifyDomainResolution(
        domain: string,
        address: AppIngressAddress | null | undefined,
    ): Promise<AppDomainResolutionResult> {
        const name = normaliseHost(domain);
        const expected = ingressTarget(address);
        const expectedKind: AppDnsRecordType | null = expected
            ? isIP(expected) !== 0
                ? 'A'
                : 'CNAME'
            : null;

        if (!name) {
            return {
                status: 'unresolved',
                verified: false,
                domain: name,
                expected,
                expectedKind,
                addresses: [],
                reason: 'No domain name was given.',
            };
        }

        if (!expected) {
            return {
                status: 'no_ingress_address',
                verified: false,
                domain: name,
                expected: null,
                expectedKind: null,
                addresses: [],
                reason:
                    'Your cluster has not reported an ingress address yet, so there is nothing to ' +
                    'verify against. Run the connection check, then verify again.',
            };
        }

        let addresses: string[];
        try {
            addresses = await this.resolveAddresses(name, expectedKind);
        } catch (error) {
            return {
                status: 'unresolved',
                verified: false,
                domain: name,
                expected,
                expectedKind,
                addresses: [],
                reason: `DNS lookup failed: ${messageOf(error)}`,
            };
        }

        if (addresses.length === 0) {
            return {
                status: 'unresolved',
                verified: false,
                domain: name,
                expected,
                expectedKind,
                addresses,
                reason: `No ${expectedKind} record was found for ${name} yet.`,
            };
        }

        const matched = addresses.some((answer) => sameHost(answer, expected));

        return matched
            ? {
                  status: 'verified',
                  verified: true,
                  domain: name,
                  expected,
                  expectedKind,
                  addresses,
                  reason: null,
              }
            : {
                  status: 'mismatch',
                  verified: false,
                  domain: name,
                  expected,
                  expectedKind,
                  addresses,
                  // Names the two addresses, never a resolved value of anything else.
                  reason:
                      `${name} resolves to ${addresses.join(', ')}, but this App Work is ` +
                      `published on ${expected}.`,
              };
    }

    /**
     * The addresses one domain resolves to, for the kind of record the expectation implies.
     *
     * `protected` so the spec pins all four outcomes without a network — the seam T22 uses for its
     * own resolver (`app-render-input.builder.ts:1007-1013`). An `A` expectation reads `A`/`AAAA`
     * records; a `CNAME` expectation reads `CNAME` records **and** follows them to addresses, because
     * an owner whose zone uses a flattened `CNAME` has a correct record and no `CNAME` answer.
     */
    protected async resolveAddresses(
        domain: string,
        expectedKind: AppDnsRecordType | null,
    ): Promise<string[]> {
        const answers = new Set<string>();

        if (expectedKind === 'CNAME') {
            try {
                for (const target of await dns.promises.resolveCname(domain)) {
                    answers.add(normaliseHost(target));
                }
            } catch {
                // A flattened or provider-managed record legitimately answers no CNAME.
            }
        }

        for (const resolver of [dns.promises.resolve4, dns.promises.resolve6]) {
            try {
                for (const address of await resolver(domain)) {
                    answers.add(address.trim());
                }
            } catch {
                // No record of that family — the other one may still answer.
            }
        }

        return [...answers];
    }

    /* ---------------------------------------------------------------------- *
     * The guarded reads and writes
     * ---------------------------------------------------------------------- */

    private async readRows(workId: string): Promise<AppCustomDomainRow[]> {
        if (!this.domains?.findByWork) return [];

        try {
            return [...((await this.domains.findByWork(workId)) ?? [])].filter(
                (row): row is AppCustomDomainRow => !!row && !!text(row.domain),
            );
        } catch (error) {
            this.logger.warn(
                `Reading the custom domains of Work ${workId} failed (${messageOf(error)}).`,
            );

            return [];
        }
    }

    private async findRow(workId: string, domain: string): Promise<AppCustomDomainRow | null> {
        const rows = await this.readRows(workId);

        return rows.find((row) => sameHost(row.domain, domain)) ?? null;
    }

    private async addRow(workId: string, domain: string): Promise<AppCustomDomainRow | null> {
        if (!this.domains?.addDomain) return null;

        try {
            return (await this.domains.addDomain(workId, domain)) ?? null;
        } catch (error) {
            this.logger.warn(
                `Adding the App custom domain ${domain} to Work ${workId} failed (${messageOf(
                    error,
                )}).`,
            );

            return null;
        }
    }

    private async removeRow(workId: string, domain: string): Promise<boolean> {
        if (!this.domains?.removeDomain) return false;

        try {
            return (await this.domains.removeDomain(workId, domain)) === true;
        } catch (error) {
            this.logger.warn(
                `Removing the App custom domain ${domain} from Work ${workId} failed (${messageOf(
                    error,
                )}).`,
            );

            return false;
        }
    }

    private async updateVerified(workId: string, domain: string, verified: boolean): Promise<void> {
        if (!this.domains?.updateVerified) return;

        try {
            await this.domains.updateVerified(workId, domain, verified);
        } catch (error) {
            this.logger.warn(
                `Recording the verification of ${domain} for Work ${workId} failed (${messageOf(
                    error,
                )}).`,
            );
        }
    }

    /** §8.4/GAP-09 — `runtimeState.ingressAddress`, the address `checkAppCluster` recorded. */
    private async readIngressAddress(workId: string): Promise<AppIngressAddress | null> {
        const state = await this.readState(workId);

        return state?.ingressAddress ?? null;
    }

    private async readState(workId: string): Promise<AppHostsRuntimeStateView | null> {
        if (!this.runtimeStates?.getOrCreate) return null;

        try {
            return (await this.runtimeStates.getOrCreate(workId)) ?? null;
        } catch (error) {
            this.logger.warn(
                `Reading the App runtime state of Work ${workId} failed (${messageOf(
                    error,
                )}); no ingress address is known, so no domain can be verified.`,
            );

            return null;
        }
    }
}

/* -------------------------------------------------------------------------- *
 * Pure helpers
 * -------------------------------------------------------------------------- */

function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function sameHost(left: string, right: string): boolean {
    return normaliseHost(left) === normaliseHost(right);
}
