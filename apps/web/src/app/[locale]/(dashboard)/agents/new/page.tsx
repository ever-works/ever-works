import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NewAgentDialog } from '@/components/agents';
import { createAgentAction } from '@/app/actions/agents';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.agentsPage.newDialog');
    return { title: t('title') };
}

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5. `/agents/new` — full
 * page wrapper for the 2-step Create dialog. v1 is page-based;
 * UX-DESIGN's modal version arrives in a later sub-tick once the
 * shared Dialog primitive is reused across Mission tab strip
 * creation flows.
 */
export default function NewAgentPage() {
    return <NewAgentDialog createAgent={createAgentAction} />;
}
