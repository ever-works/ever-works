import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { agentsAPI } from '@/lib/api/agents';
import { AgentDetailTabs } from '@/components/agents';

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
    const agent = await agentsAPI.get(id);
    return { title: agent?.name ?? 'Agent' };
}

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5. `/agents/[id]` shell.
 * Server-fetches the Agent once for the header + ownership check;
 * cross-user reads return null (controller already 404s), in
 * which case we fall to Next.js notFound() so the route resolves
 * cleanly instead of rendering an undefined header.
 *
 * Individual tab content lives in nested `page.tsx` files under
 * this layout — see `./instructions/page.tsx` etc.
 */
export default async function AgentLayout({ params, children }: LayoutParams) {
    const { id } = await params;
    const agent = await agentsAPI.get(id);
    if (!agent) {
        notFound();
    }

    return (
        <div className="flex flex-col h-full min-h-0">
            <header className="px-6 py-4 border-b border-border/60 dark:border-border-dark/60">
                <h1 className="text-xl font-semibold text-text dark:text-text-dark">
                    {agent.name}
                </h1>
                {agent.title && (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5">
                        {agent.title}
                    </p>
                )}
            </header>
            <AgentDetailTabs agentId={agent.id} />
            <div className="flex-1 min-h-0 overflow-auto">{children}</div>
        </div>
    );
}
