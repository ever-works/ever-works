import type { Metadata } from 'next';
import { Work, workAPI, gitProvidersAPI, GitProviderConnectionInfo } from '@/lib/api';
import { agentsAPI, type Agent } from '@/lib/api/agents';
import { notFound } from 'next/navigation';
import { WorkLayoutClient } from '@/components/works/detail/WorkLayoutClient';
import { getTranslations } from 'next-intl/server';
import { APP_NAME } from '@/lib/constants';

type LayoutParams = {
    params: Promise<{ id: string }>;
    children: React.ReactNode;
};

export async function generateMetadata({
    params,
}: {
    params: Promise<{ id: string }>;
}): Promise<Metadata> {
    const { id } = await params;
    const t = await getTranslations('metadata.pages');
    try {
        const { work } = await workAPI.get(id);
        return {
            title: {
                template: `%s - ${work.name} | ${APP_NAME}`,
                default: work.name,
            },
        };
    } catch {
        return { title: t('work') };
    }
}

export default async function WorkLayout({ params, children }: LayoutParams) {
    const { id } = await params;

    let work: Work;
    let oauthConnection: GitProviderConnectionInfo | null = null;
    let config = null;
    let agents: Agent[] = [];
    let agentsTotal = 0;
    let assignedAgentIds: string[] = [];

    try {
        const res = await workAPI.get(id);
        work = res.work;
        // Sourced from the cached `works.yml` payload the API
        // populated alongside the Work row. No extra git clone
        // needed; see `DataGeneratorService.refreshDataCache`.
        config = work.configCache ?? null;

        if (work) {
            // Fetch connection info, provider list, and the Agents on this
            // Work (header dropdown) in parallel. "On this Work" is two
            // populations: Agents PINNED here by scope, and tenant-scoped
            // Agents ASSIGNED here through their `targets`. The dropdown
            // shows one merged list and tells them apart via
            // `assignedAgentIds` (assignment is detachable, pinning is not).
            const [connectionRes, providersRes, agentsRes, assignedRes] = await Promise.all([
                gitProvidersAPI.checkConnection(work.gitProvider).catch(() => null),
                gitProvidersAPI.list().catch(() => null),
                agentsAPI.list({ scope: 'work', workId: id, limit: 50 }).catch(() => null),
                agentsAPI.list({ assignedWorkId: id, limit: 50 }).catch(() => null),
            ]);

            const pinned = agentsRes?.data ?? [];
            const assigned = assignedRes?.data ?? [];
            const pinnedIds = new Set(pinned.map((agent) => agent.id));
            const assignedOnly = assigned.filter((agent) => !pinnedIds.has(agent.id));

            agents = [...pinned, ...assignedOnly];
            assignedAgentIds = assignedOnly.map((agent) => agent.id);
            agentsTotal =
                (agentsRes?.meta?.total ?? pinned.length) +
                // Only the rows we actually merged in can be counted from the
                // assigned page; a capped assigned fetch is reflected by the
                // "+N more" row rather than a total the list can't back up.
                assignedOnly.length;

            oauthConnection = connectionRes;

            // If checkConnection failed but we have provider info from the list,
            // build a minimal connection object so repo links still work
            if (!oauthConnection && providersRes) {
                const provider = providersRes.providers?.find((p) => p.id === work.gitProvider);
                if (provider) {
                    oauthConnection = { ...provider, connected: false };
                }
            }
        }
    } catch (error) {
        console.error('Failed to fetch Work:', error);
        notFound();
    }

    return (
        <WorkLayoutClient
            work={work}
            oauthConnection={oauthConnection}
            config={config}
            agents={agents}
            agentsTotal={agentsTotal}
            assignedAgentIds={assignedAgentIds}
        >
            {children}
        </WorkLayoutClient>
    );
}
