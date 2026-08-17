'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Plug, RotateCcw } from 'lucide-react';
import {
    clearAgentMcpBindingAction,
    listAgentMcpServersAction,
    setAgentMcpBindingAction,
} from '@/app/actions/mcp-connections';
import type { AgentMcpServerState } from '@/lib/api/mcp-connections';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

interface Props {
    agentId: string;
    initial: { data: AgentMcpServerState[] };
}

/**
 * Agent Plugins MCP slice (US-7 / T27) — per-agent MCP server list with
 * toggles + inherited badges. Toggling writes an agent-level override
 * row; "revert" removes it so the tenant-level binding decides again.
 */
export function AgentMcpServersClient({ agentId, initial }: Props) {
    const t = useTranslations('dashboard.agentsPage.mcpServers');
    const [rows, setRows] = useState(initial.data);
    const [pending, startTransition] = useTransition();
    const [busyId, setBusyId] = useState<string | null>(null);

    const run = (connectionId: string, fn: () => Promise<unknown>) => {
        setBusyId(connectionId);
        startTransition(() => {
            void (async () => {
                try {
                    await fn();
                    const next = await listAgentMcpServersAction(agentId);
                    setRows(next.data);
                } finally {
                    setBusyId(null);
                }
            })();
        });
    };

    return (
        <div className="p-6 max-w-screen-2xl mx-auto space-y-4">
            <header className="flex items-center justify-between">
                <div>
                    <h2 className="text-sm font-medium text-text dark:text-text-dark">
                        {t('title')}
                    </h2>
                    <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('subtitle')}
                    </p>
                </div>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('activeCount', {
                        count: rows.filter((r) => r.effectiveEnabled).length,
                    })}
                </p>
            </header>
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark divide-y divide-border/40 dark:divide-border-dark/40">
                {rows.length === 0 ? (
                    <div className="p-6 text-center text-xs text-text-muted dark:text-text-muted-dark">
                        {t('empty')}
                    </div>
                ) : (
                    rows.map((row) => (
                        <article key={row.connection.id} className="p-4 flex items-center gap-3">
                            <Plug className="w-4 h-4 text-primary shrink-0" />
                            <div className="min-w-0 flex-1">
                                <div className="text-sm text-text dark:text-text-dark truncate">
                                    {row.connection.name}{' '}
                                    <span className="text-text-muted dark:text-text-muted-dark text-xs font-mono">
                                        {row.connection.transport}
                                    </span>
                                    {row.inheritedFromTenant && (
                                        <span className="ml-2 inline-flex items-center rounded-full bg-surface-secondary dark:bg-surface-secondary-dark px-2 py-0.5 text-[10px] text-text-muted dark:text-text-muted-dark">
                                            {t('inherited')}
                                        </span>
                                    )}
                                    {row.bindingSource === 'agent' && (
                                        <span className="ml-2 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                                            {t('overridden')}
                                        </span>
                                    )}
                                    {!row.connection.enabled && (
                                        <span className="ml-2 inline-flex items-center rounded-full bg-danger/10 px-2 py-0.5 text-[10px] text-danger">
                                            {t('connectionDisabled')}
                                        </span>
                                    )}
                                </div>
                                <div className="mt-0.5 text-[11px] font-mono text-text-muted dark:text-text-muted-dark truncate">
                                    {row.connection.url}
                                </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                {row.bindingSource === 'agent' && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                            run(row.connection.id, () =>
                                                clearAgentMcpBindingAction(
                                                    agentId,
                                                    row.connection.id,
                                                ),
                                            )
                                        }
                                        disabled={pending && busyId === row.connection.id}
                                        className="gap-1"
                                        title={t('revert')}
                                    >
                                        <RotateCcw className="w-3.5 h-3.5" />
                                        {t('revert')}
                                    </Button>
                                )}
                                <Switch
                                    checked={row.effectiveEnabled}
                                    disabled={
                                        (pending && busyId === row.connection.id) ||
                                        !row.connection.enabled
                                    }
                                    onChange={(checked) =>
                                        run(row.connection.id, () =>
                                            setAgentMcpBindingAction(
                                                agentId,
                                                row.connection.id,
                                                checked,
                                            ),
                                        )
                                    }
                                    data-testid={`agent-mcp-toggle-${row.connection.name}`}
                                />
                            </div>
                        </article>
                    ))
                )}
            </section>
        </div>
    );
}
