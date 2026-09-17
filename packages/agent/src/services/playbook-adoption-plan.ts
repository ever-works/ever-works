import { createHash } from 'crypto';
import type {
    PlaybookAdoptionPlan,
    PlaybookCatalogEntry,
    PlaybookPlanItem,
} from '@ever-works/contracts';

export interface PlanAdoptionInput {
    /** The instance name the person chose; defaults to the playbook title. */
    readonly instanceName?: string;
    /** The Agent name to create; defaults to the playbook's own, de-duplicated by preflight. */
    readonly agentName?: string;
    /** `HH:MM` override for `schedule` triggers. */
    readonly localTime?: string;
}

/**
 * Capability & playbook catalogue (AW-21) — the itemised list of what
 * setting a playbook up would create.
 *
 * Pure, no IO. This one function is the single source of both the setup
 * sheet's list and the provisioning steps, so a step that creates a row the
 * sheet did not show is a unit-test failure rather than a review catch.
 *
 * Guardrails are ALWAYS planned as `require_approval`, whatever posture the
 * playbook declares as graduated: adoption only ever offers more autonomy
 * later, it never applies it up front.
 */
export function planAdoption(
    entry: PlaybookCatalogEntry,
    input: PlanAdoptionInput = {},
): PlaybookAdoptionPlan {
    const instanceName = input.instanceName?.trim() || entry.title;
    const agentName = input.agentName?.trim() || entry.provision.agentName;
    const items: PlaybookPlanItem[] = [
        {
            type: 'agent',
            count: 1,
            names: [agentName],
            detail: { template: entry.provision.agentTemplateSlug },
        },
    ];

    if (entry.provision.skillSlugs.length > 0) {
        items.push({
            type: 'skills',
            count: entry.provision.skillSlugs.length,
            names: [...entry.provision.skillSlugs],
            detail: { boundTo: agentName },
        });
    }

    items.push({
        type: 'task_template',
        count: 1,
        names: [entry.provision.taskTemplate.name],
        detail: {
            steps: entry.steps.length,
            needApproval: entry.steps.filter((step) => step.requiresApproval).length,
        },
    });

    const blocked = entry.provision.guardrailsAtAdoption.blockedActionTypes ?? [];
    items.push({
        type: 'guardrails',
        count: 0,
        names: [],
        detail: { mode: 'require_approval', blockedActionTypes: blocked.join(',') },
    });

    if (entry.trigger.kind === 'schedule') {
        const detail: Record<string, string> = {
            localTime: input.localTime ?? entry.trigger.defaultLocalTime ?? '',
        };
        if (entry.trigger.cadence) detail.cadence = entry.trigger.cadence;
        items.push({ type: 'schedule', count: 1, names: [instanceName], detail });
    } else if (entry.trigger.kind === 'inbound_trigger') {
        items.push({ type: 'inbound_trigger', count: 1, names: [instanceName], detail: {} });
    }

    if (entry.provision.workflowGraph) {
        items.push({
            type: 'workflow',
            count: 1,
            names: [entry.provision.workflowGraph.name ?? instanceName],
            detail: { nodes: entry.provision.workflowGraph.nodes.length },
        });
    }

    return {
        slug: entry.slug,
        version: entry.version,
        instanceName,
        items,
        planHash: hashAdoptionPlan({
            slug: entry.slug,
            version: entry.version,
            instanceName,
            items,
        }),
    };
}

/** Serialise with sorted keys so equal plans always hash equal. */
function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/** SHA-256 hex of a plan (its `planHash` field, if present, is ignored). */
export function hashAdoptionPlan(
    plan: Pick<PlaybookAdoptionPlan, 'slug' | 'version' | 'instanceName' | 'items'>,
): string {
    const { slug, version, instanceName, items } = plan;
    return createHash('sha256')
        .update(stableStringify({ slug, version, instanceName, items }))
        .digest('hex');
}
