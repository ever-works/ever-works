/**
 * APW-06 T48 (A0.8, lane aw-deploy-2, 2026-10-17) — **the managed subdomain's DNS record**.
 *
 * After a Deployment of a Your-cluster App Work goes live (`app.deploy.succeeded`, relayed from the
 * isolated worker), point `<label>.<apps domain>` at the address the cluster's ingress reported
 * (`work_app_runtime_states.ingressAddress`, written by the orchestrator in §5.6 step 6). The
 * label is allocated (idempotently) first, so a Work whose label was never allocated gets one.
 *
 * Runs in the API: a Cloudflare call is not cluster I/O, and the apps-DNS token lives here. Skips
 * — never fails — when the apps domain or apps DNS is not configured, the owner switched the
 * managed subdomain off, the target is not Your cluster (the managed tier publishes its own), or
 * the ingress address is not public.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
import {
    AppsDomainDnsServiceImpl,
    type AppsDomainRecordOutcome,
} from '../ever-works-providers/apps-domain-dns.service';

@Injectable()
export class AppManagedDnsListener {
    private readonly logger = new Logger(AppManagedDnsListener.name);

    constructor(
        @Optional() private readonly dns?: AppsDomainDnsServiceImpl,
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly states?: {
            getOrCreate(workId: string): Promise<{
                target?: string | null;
                ingressAddress?: { ip?: string | null; hostname?: string | null } | null;
                targetSettings?: { managedSubdomain?: boolean | null } | null;
            } | null>;
        },
    ) {}

    @OnEvent('app.deploy.succeeded', { async: true })
    async onDeploySucceeded(payload: { workId?: unknown }): Promise<AppsDomainRecordOutcome> {
        const workId = typeof payload?.workId === 'string' ? payload.workId : '';
        try {
            if (!workId || !this.dns || !this.states?.getOrCreate) {
                return { status: 'skipped', reason: 'unbound' };
            }
            const state = await this.states.getOrCreate(workId);
            if (state?.target !== 'your-cluster')
                return { status: 'skipped', reason: 'not_your_cluster' };
            if (state.targetSettings?.managedSubdomain === false) {
                return { status: 'skipped', reason: 'managed_subdomain_off' };
            }
            await this.dns.allocate(workId);
            return await this.dns.ensureFor(workId, state.ingressAddress ?? null);
        } catch (error) {
            this.logger.warn(
                `The managed DNS record of Work ${workId} could not be ensured: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return { status: 'skipped', reason: 'threw' };
        }
    }
}
