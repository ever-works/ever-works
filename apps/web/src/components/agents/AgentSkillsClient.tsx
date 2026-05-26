'use client';

import { useState, useTransition } from 'react';
import { Sparkles, Trash2 } from 'lucide-react';
import { agentsAPI } from '@/lib/api/agents';
import { skillsAPI } from '@/lib/api/skills';
import { Button } from '@/components/ui/button';

interface BoundSkill {
    bindingId: string;
    priority: number;
    targetType: string;
    skill: { id: string; slug: string; title: string; version: string };
}

interface Props {
    agentId: string;
    initial: { data: BoundSkill[] };
}

export function AgentSkillsClient({ agentId, initial }: Props) {
    const [rows, setRows] = useState(initial.data);
    const [pending, startTransition] = useTransition();
    const [removingId, setRemovingId] = useState<string | null>(null);

    const removeBinding = (bindingId: string) => {
        setRemovingId(bindingId);
        startTransition(() => {
            void (async () => {
                try {
                    await skillsAPI.deleteBinding(bindingId);
                    const next = await agentsAPI.listSkills(agentId);
                    setRows(next.data);
                } finally {
                    setRemovingId(null);
                }
            })();
        });
    };

    return (
        <div className="p-6 max-w-screen-2xl mx-auto space-y-4">
            <header className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-text dark:text-text-dark">Skills</h2>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {rows.length} active binding{rows.length === 1 ? '' : 's'}
                </p>
            </header>
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark divide-y divide-border/40 dark:divide-border-dark/40">
                {rows.length === 0 ? (
                    <div className="p-6 text-center text-xs text-text-muted dark:text-text-muted-dark">
                        No skills bound yet. Bind a Skill to this Agent from the Skills detail
                        page.
                    </div>
                ) : (
                    rows.map((r) => (
                        <article key={r.bindingId} className="p-4 flex items-center gap-3">
                            <Sparkles className="w-4 h-4 text-primary shrink-0" />
                            <div className="min-w-0 flex-1">
                                <div className="text-sm text-text dark:text-text-dark truncate">
                                    {r.skill.title}{' '}
                                    <span className="text-text-muted dark:text-text-muted-dark text-xs font-mono">
                                        {r.skill.slug} · v{r.skill.version}
                                    </span>
                                </div>
                                <div className="mt-0.5 flex items-center gap-3 text-[11px] text-text-muted dark:text-text-muted-dark">
                                    <span>priority {r.priority}</span>
                                    <span>· {r.targetType} binding</span>
                                </div>
                            </div>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => removeBinding(r.bindingId)}
                                disabled={pending && removingId === r.bindingId}
                                className="text-danger hover:text-danger gap-1.5"
                                title="Remove binding"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                                {pending && removingId === r.bindingId ? '…' : 'Remove'}
                            </Button>
                        </article>
                    ))
                )}
            </section>
        </div>
    );
}
