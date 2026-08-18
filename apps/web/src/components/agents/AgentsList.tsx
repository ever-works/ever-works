'use client';

import { useState, useTransition } from 'react';
import { Bot, Network, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';
import { Link, useRouter } from '@/i18n/navigation';
import {
    PromptComposer,
    buildAttachmentRefs,
    type ComposerAttachment,
} from '@/components/common/PromptComposer';
import { useStartFromPrompt } from '@/lib/hooks/use-start-from-prompt';
import { AgentCard } from './AgentCard';
import { AgentTemplateChips } from './AgentTemplateChips';
import { PageHeader } from '@/components/common/PageHeader';
import type { Agent } from '@/lib/api/agents';
import type { AstTemplateEntry } from '@/lib/api/agent-templates';

/**
 * Agents catalog page client. Brings the Agents page to parity with
 * Missions / Ideas / Works: a prompt-first `PromptComposer` at the top
 * (type what you want → the chat AI builds it + a Canvas to edit),
 * agent-template quick-pick chips below the input, and an `Or` block
 * with `+ Create Agent Manually` (the relabelled former `+ New Agent`,
 * moved out of the header per the operator request) for the manual
 * wizard. The existing AgentCard grid stays below, unchanged.
 *
 * Spec: docs/specs/features/agent-prompt-first-creation/spec.md
 */

/** Stable id so a chip pick can refocus the composer textarea. */
const PROMPT_INPUT_ID = 'agents-prompt';

/** Agent-flavoured placeholder cycle — mirrors the agent examples used
 *  by the unified `/new` page so the surfaces feel like one primitive. */
/**
 * Secondary-button chrome for the header's "Agents Chart" link. A plain
 * `<Link>` rather than `<Button href>` on purpose: the Button's href branch
 * renders a `LinkComponent` with an explicit prop list (href/className/
 * target/rel/children) and therefore drops every extra prop — including the
 * `data-testid` the e2e journey and the unit spec below select the CTA by.
 * Classes mirror `<Button variant="secondary" size="sm">` so the two controls
 * are visually identical; the same idiom is used on the Teams page.
 */
const CHART_LINK_CLASSES =
    'inline-flex cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 dark:focus-visible:ring-white/20 [&_svg]:shrink-0 ' +
    'h-8 px-3 text-xs border border-border dark:border-border-dark ' +
    'bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark ' +
    'text-button-primary-foreground dark:text-button-primary-foreground-dark';

const AGENT_PLACEHOLDERS: ReadonlyArray<string> = [
    'e.g. "Research assistant that fetches AI safety papers and summarizes them weekly"',
    'e.g. "Content editor that rewrites our directory descriptions in a consistent voice"',
    'e.g. "Release-notes drafter that watches a repo and proposes draft notes"',
    'e.g. "PR triage agent that labels new community PRs and suggests reviewers"',
];

export interface AgentsListProps {
    agents: Agent[];
    /** Catalog templates for the chips + `View All` panel. */
    templates?: ReadonlyArray<AstTemplateEntry>;
    /** The user's own templates ("Your templates" section). */
    userTemplates?: ReadonlyArray<AstTemplateEntry>;
}

export function AgentsList({ agents, templates = [], userTemplates = [] }: AgentsListProps) {
    const t = useTranslations('dashboard.agentsPage');
    const router = useRouter();
    const startFromPrompt = useStartFromPrompt();
    const [prompt, setPrompt] = useState('');
    const [attachments, setAttachments] = useState<ReadonlyArray<ComposerAttachment>>([]);
    const [submitting, startSubmit] = useTransition();

    const submit = () => {
        const description = prompt.trim();
        if (description.length < 10) {
            toast.error(t('prompt.minLength'));
            return;
        }
        startSubmit(() => {
            // Same contract as the unified /new page's Agent chip: hand
            // the prompt to the chat AI, then route to the Agent Canvas
            // (the wizard) where the user can edit in parallel. No
            // `?prompt=` — the chat already carries it.
            startFromPrompt(description, {
                intent: 'Agent',
                attachments: buildAttachmentRefs(attachments),
            });
            router.push(ROUTES.DASHBOARD_AGENT_NEW);
        });
    };

    // Clicking a template chip seeds the composer (spec Q1 default): if
    // the box is empty, seed it with the template's one-liner; if the
    // user already typed something, prepend the role label so their text
    // is preserved. Then refocus the input so they can elaborate.
    const handlePickTemplate = (tpl: AstTemplateEntry) => {
        setPrompt((prev) => {
            const trimmed = prev.trim();
            if (!trimmed) return tpl.description || tpl.title;
            return `${tpl.title} — ${trimmed}`;
        });
        if (typeof document !== 'undefined') {
            requestAnimationFrame(() => {
                document.getElementById(PROMPT_INPUT_ID)?.focus();
            });
        }
    };

    return (
        <div className="w-full">
            <PageHeader
                icon={Bot}
                title={t('title')}
                subtitle={t('subtitle')}
                tone="agent"
                actions={
                    /* Navigation consolidation §3.6 — the Agents Chart is the
                       agent-only view of the org chart (human members stripped),
                       and this header CTA is its only entry point. */
                    <Link
                        href={ROUTES.DASHBOARD_AGENTS_CHART}
                        data-testid="agents-chart-link"
                        className={CHART_LINK_CLASSES}
                    >
                        <Network className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />
                        {t('agentsChartCta')}
                    </Link>
                }
            />

            {/* Prompt-first surface — describe the Agent you want. Chips
                with quick-pick templates + `View All` render below the
                input (matches the /new + marketing layouts). */}
            <div className="mb-4">
                <label
                    htmlFor={PROMPT_INPUT_ID}
                    className="block text-xs font-medium uppercase tracking-wide text-text-muted dark:text-text-muted-dark mb-2"
                >
                    {t('prompt.label')}
                </label>
                <PromptComposer
                    inputId={PROMPT_INPUT_ID}
                    value={prompt}
                    onChange={setPrompt}
                    onSubmit={submit}
                    submitting={submitting}
                    placeholderExamples={AGENT_PLACEHOLDERS}
                    ariaLabel={t('prompt.label')}
                    submitTitle={t('prompt.submitTitle')}
                    testId="agents-prompt"
                    onAttachmentsChange={setAttachments}
                    chipsBelow={
                        <AgentTemplateChips
                            templates={templates}
                            userTemplates={userTemplates}
                            onPick={handlePickTemplate}
                        />
                    }
                />
            </div>

            {/* `Or` block — the manual wizard as the explicit alternative
                to the prompt (former `+ New Agent`, relabelled + moved
                out of the header). Mirrors the Works page treatment. */}
            <div
                className="my-6 flex items-center gap-3"
                role="separator"
                aria-label={t('orDivider')}
            >
                <span className="h-px flex-1 bg-border/60 dark:bg-border-dark/60" />
                <span className="text-xs uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                    {t('orDivider')}
                </span>
                <span className="h-px flex-1 bg-border/60 dark:bg-border-dark/60" />
            </div>
            <div className="mb-8 flex justify-center">
                <Button
                    href={ROUTES.DASHBOARD_AGENT_NEW}
                    variant="secondary"
                    size="sm"
                    className="gap-1.5"
                >
                    <Plus className="w-3.5 h-3.5" />
                    {t('createManually')}
                </Button>
            </div>

            {agents.length === 0 ? (
                <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-6">
                    <p className="text-sm text-text dark:text-text-dark">{t('empty.title')}</p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 max-w-2xl">
                        {t('empty.subtitle')}
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
                    {agents.map((a) => (
                        <AgentCard key={a.id} agent={a} />
                    ))}
                </div>
            )}
        </div>
    );
}
