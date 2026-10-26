import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import {
    FLEET_CLOUD_UNENROLLED_AFTER_MIN,
    fleetCloudIdleHours,
    formatFleetCloudMoney,
    type FleetNodeView,
    type NeedsALookItem,
} from '@ever-works/contracts';
import type { NeedsALookContext, NeedsALookProducer } from '../needs-a-look/needs-a-look.producer';
import { NeedsALookService } from '../needs-a-look/needs-a-look.service';

/**
 * Cloud computers (FL-17, CONTRACTS §4.6, spec FR-11, U3) — the `cloud-idle`
 * "needs a look" producer. CONTRACTS has ONE cloud kind; the variant is in the
 * title, detail and action:
 *
 *  - **never came online** (P1): the provider runs the machine, but it has not
 *    heartbeated 10 minutes after the create — "nyc-ops never came online and
 *    is billing $0.036/h", with Destroy… (the machine's first-boot script cannot
 *    be replaced at the first provider, so Destroy is the fix);
 *  - **create failed** (U2): the provider refused — info, with the provider's
 *    first line; Remove is allowed (no machine exists);
 *  - **gone at the provider** (U6): the machine was destroyed outside Ever
 *    Works — info, Remove from Fleet is now available.
 *
 * P2 (spec S6, S7, FR-27) adds, from what the idle job keeps on the row:
 *
 *  - **idle for N h** — the idle window reached the policy's hours (Tell me,
 *    or Power off before the job acted): "fra-nina has been idle for 4 h ·
 *    $0.28 while idle", with Power off… (Keep running is on the Cloud block);
 *  - **powered off by policy** — "fra-nina was powered off after 2 h idle —
 *    it still bills while off", with Power on… (Destroy… is on the page).
 *
 * The id carries the window start, so one window is one item (FR-27). Computed
 * on read from the Cloud block every view already carries; owner-only facts
 * are none (prices and states are shared, spec S10). Registers itself into
 * FL-01's registry at module init.
 */
export function cloudIdleItems(nodes: readonly FleetNodeView[], context: Pick<NeedsALookContext, 'now'>): NeedsALookItem[] {
    const items: NeedsALookItem[] = [];
    const nowMs = context.now.getTime();
    for (const node of nodes) {
        const cloud = node.cloud;
        if (!cloud) continue;
        const route = `/fleet/computers/${encodeURIComponent(node.id)}?tab=overview`;
        const rate = formatFleetCloudMoney(cloud.hourlyRateCents, { currency: cloud.currency, perHour: true });
        if (cloud.powerState === 'gone') {
            items.push({
                id: `cloud-idle:${node.id}:gone`,
                nodeId: node.id,
                severity: 'info',
                kind: 'cloud-idle',
                title: `${node.name} is gone at ${cloud.providerName}`,
                detail: 'It no longer bills. Remove it from the Fleet when you are done with its history.',
                action: { label: 'Remove…', route },
                since: cloud.goneAt ?? cloud.powerStateAt,
            });
            continue;
        }
        if (cloud.phase === 'failed') {
            items.push({
                id: `cloud-idle:${node.id}:failed`,
                nodeId: node.id,
                severity: 'warn',
                kind: 'cloud-idle',
                title: `${node.name} could not be created`,
                detail: cloud.error ?? `${cloud.providerName} refused the create. Nothing bills; remove it and try again.`,
                action: { label: 'Open', route },
                since: cloud.phaseAt,
            });
            continue;
        }
        if (
            cloud.poweredOffByPolicyAt &&
            ((cloud.powerState === 'off' && cloud.pending === null) || cloud.pending === 'powering-off')
        ) {
            const hours = cloud.idlePolicy.afterHours;
            items.push({
                id: `cloud-idle:${node.id}:powered-off:${cloud.poweredOffByPolicyAt}`,
                nodeId: node.id,
                severity: cloud.billsWhileOff ? 'warn' : 'info',
                kind: 'cloud-idle',
                title: cloud.billsWhileOff
                    ? `${node.name} was powered off after ${hours} h idle — it still bills while off`
                    : `${node.name} was powered off after ${hours} h idle`,
                detail: cloud.billsWhileOff
                    ? `${cloud.providerName} bills this size while it is off (${rate}/h). Destroy it to stop the bill, or power it on when you need it.`
                    : 'Power it on when you need it again.',
                action: { label: 'Power on…', route: `${route}&cloud=power-on` },
                since: cloud.poweredOffByPolicyAt,
            });
            continue;
        }
        if (cloud.idleWindowReached && cloud.idleSince && cloud.pending === null) {
            const hours = fleetCloudIdleHours(cloud.idleSince, nowMs) ?? cloud.idlePolicy.afterHours;
            const sinceMs = Date.parse(cloud.idleSince);
            const whileIdle = Number.isFinite(sinceMs)
                ? formatFleetCloudMoney((Math.max(0, nowMs - sinceMs) / 3_600_000) * cloud.cost.hourlyCents, {
                      currency: cloud.currency,
                  })
                : null;
            items.push({
                id: `cloud-idle:${node.id}:idle:${cloud.idleSince}`,
                nodeId: node.id,
                severity: 'warn',
                kind: 'cloud-idle',
                title: whileIdle
                    ? `${node.name} has been idle for ${hours} h · ${whileIdle} while idle`
                    : `${node.name} has been idle for ${hours} h`,
                detail: `No session working, no job running and the CPU under 5 % since then; it bills ${rate}/h. Power it off, or keep it running from its page.`,
                action: { label: 'Power off…', route: `${route}&cloud=power-off` },
                since: cloud.idleSince,
            });
            continue;
        }
        const created = Date.parse(cloud.machineCreatedAt ?? '');
        const unenrolled =
            node.status === 'enrolling' &&
            Number.isFinite(created) &&
            nowMs - created > FLEET_CLOUD_UNENROLLED_AFTER_MIN * 60_000;
        if (unenrolled) {
            const minutes = Math.round((nowMs - created) / 60_000);
            items.push({
                id: `cloud-idle:${node.id}:unenrolled`,
                nodeId: node.id,
                severity: 'warn',
                kind: 'cloud-idle',
                title: `${node.name} never came online and is billing ${rate}`,
                detail: `Created ${minutes} min ago at ${cloud.providerName}. Destroy it to stop the bill, then create it again.`,
                action: { label: 'Destroy…', route: `${route}&cloud=destroy` },
                since: new Date(created).toISOString(),
            });
        }
    }
    return items;
}

@Injectable()
export class CloudIdleNeedsALookProducer implements NeedsALookProducer, OnModuleInit {
    readonly id = 'fl-17.cloud-idle';

    constructor(@Optional() private readonly registry?: NeedsALookService) {}

    onModuleInit(): void {
        this.registry?.register(this);
    }

    produce(nodes: readonly FleetNodeView[], context: NeedsALookContext): NeedsALookItem[] {
        return cloudIdleItems(nodes, context);
    }
}
