'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { RotateCcw, Save, Shield } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useRouter } from '@/i18n/navigation';
import { updateAgentGuardrailsAction } from '@/app/actions/agents';
import {
    AGENT_GUARDRAIL_ACTION_TYPES,
    type AgentGuardrailActionType,
    type AgentGuardrails,
    type AgentGuardrailsMode,
} from '@/lib/api/agents.shared';

interface AgentGuardrailsCardProps {
    agentId: string;
    initial: AgentGuardrails | null;
}

/**
 * Agent Dispatch Guardrails card (Agent detail dashboard). Lets the
 * operator pick a dispatch mode (require approval vs autonomous),
 * narrow which action types may auto-approve, and block action types
 * outright. Mirrors the pure policy shape in
 * `packages/agent/src/agents/guardrails.ts`; saved via
 * `PUT /api/agents/:id/guardrails`.
 *
 * House rule: explicit `isSubmitting` state (not
 * `useTransition().pending`) for the form's save affordance.
 */
export function AgentGuardrailsCard({ agentId, initial }: AgentGuardrailsCardProps) {
    const t = useTranslations('dashboard.agentsPage.guardrails');
    const router = useRouter();

    const [mode, setMode] = useState<AgentGuardrailsMode>(initial?.mode ?? 'require_approval');
    // Omitted auto-approve list = "every type is eligible", so the
    // checkboxes start all-checked in that case; an explicit subset
    // starts as exactly that subset.
    const [autoApprove, setAutoApprove] = useState<AgentGuardrailActionType[]>(
        initial?.autoApproveActionTypes ?? [...AGENT_GUARDRAIL_ACTION_TYPES],
    );
    const [blocked, setBlocked] = useState<AgentGuardrailActionType[]>(
        initial?.blockedActionTypes ?? [],
    );
    const [isSubmitting, setIsSubmitting] = useState(false);

    const toggleAutoApprove = (actionType: AgentGuardrailActionType, checked: boolean) => {
        setAutoApprove((current) =>
            checked ? [...current, actionType] : current.filter((type) => type !== actionType),
        );
        // The two lists must never overlap (server rejects it) — checking
        // a type here unchecks it on the blocked side.
        if (checked) {
            setBlocked((current) => current.filter((type) => type !== actionType));
        }
    };

    const toggleBlocked = (actionType: AgentGuardrailActionType, checked: boolean) => {
        setBlocked((current) =>
            checked ? [...current, actionType] : current.filter((type) => type !== actionType),
        );
        if (checked) {
            setAutoApprove((current) => current.filter((type) => type !== actionType));
        }
    };

    const buildPayload = (): AgentGuardrails => {
        const payload: AgentGuardrails = { mode };
        // All boxes checked = the omitted-list semantics ("every
        // unflagged type may auto-approve") — send it as omitted.
        if (mode === 'autonomous' && autoApprove.length < AGENT_GUARDRAIL_ACTION_TYPES.length) {
            payload.autoApproveActionTypes = AGENT_GUARDRAIL_ACTION_TYPES.filter((type) =>
                autoApprove.includes(type),
            );
        }
        if (blocked.length > 0) {
            payload.blockedActionTypes = AGENT_GUARDRAIL_ACTION_TYPES.filter((type) =>
                blocked.includes(type),
            );
        }
        return payload;
    };

    const save = async () => {
        setIsSubmitting(true);
        try {
            await updateAgentGuardrailsAction(agentId, buildPayload());
            toast.success(t('saveSuccess'));
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t('saveError'));
        } finally {
            setIsSubmitting(false);
        }
    };

    const reset = async () => {
        setIsSubmitting(true);
        try {
            await updateAgentGuardrailsAction(agentId, null);
            setMode('require_approval');
            setAutoApprove([...AGENT_GUARDRAIL_ACTION_TYPES]);
            setBlocked([]);
            toast.success(t('resetSuccess'));
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t('saveError'));
        } finally {
            setIsSubmitting(false);
        }
    };

    const modeOptions: Array<{ value: AgentGuardrailsMode; label: string; hint: string }> = [
        {
            value: 'require_approval',
            label: t('modeRequireApproval'),
            hint: t('modeRequireApprovalHint'),
        },
        { value: 'autonomous', label: t('modeAutonomous'), hint: t('modeAutonomousHint') },
    ];

    return (
        <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-4">
            <div className="flex items-start gap-3">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                    <Shield className="w-4 h-4 text-primary" />
                </div>
                <div>
                    <h2 className="text-sm font-medium text-text dark:text-text-dark">
                        {t('title')}
                    </h2>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('subtitle')}
                    </p>
                </div>
            </div>

            {/* Dispatch mode */}
            <fieldset>
                <legend className="block text-xs font-medium text-text dark:text-text-dark mb-2">
                    {t('modeLabel')}
                </legend>
                <div className="grid gap-3 md:grid-cols-2">
                    {modeOptions.map((option) => (
                        <label
                            key={option.value}
                            className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                                mode === option.value
                                    ? 'border-primary/50 bg-primary/5'
                                    : 'border-border/50 dark:border-border-dark/50 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark'
                            }`}
                        >
                            <input
                                type="radio"
                                name="guardrails-mode"
                                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary focus:ring-2 focus:ring-primary"
                                value={option.value}
                                checked={mode === option.value}
                                onChange={() => setMode(option.value)}
                            />
                            <span className="min-w-0">
                                <span className="block text-xs font-medium text-text dark:text-text-dark">
                                    {option.label}
                                </span>
                                <span className="mt-0.5 block text-[11px] leading-snug text-text-muted dark:text-text-muted-dark">
                                    {option.hint}
                                </span>
                            </span>
                        </label>
                    ))}
                </div>
            </fieldset>

            {/* Auto-approve narrowing — only meaningful in autonomous mode */}
            {mode === 'autonomous' ? (
                <fieldset>
                    <legend className="block text-xs font-medium text-text dark:text-text-dark mb-1">
                        {t('autoApproveLabel')}
                    </legend>
                    <p className="mb-2 text-[11px] text-text-muted dark:text-text-muted-dark">
                        {t('autoApproveHint')}
                    </p>
                    <div className="grid gap-2 md:grid-cols-2">
                        {AGENT_GUARDRAIL_ACTION_TYPES.map((actionType) => (
                            <Checkbox
                                key={actionType}
                                label={t(`actionTypes.${actionType}`)}
                                checked={autoApprove.includes(actionType)}
                                onChange={(event) =>
                                    toggleAutoApprove(actionType, event.target.checked)
                                }
                            />
                        ))}
                    </div>
                </fieldset>
            ) : null}

            {/* Blocked action types */}
            <fieldset>
                <legend className="block text-xs font-medium text-text dark:text-text-dark mb-1">
                    {t('blockedLabel')}
                </legend>
                <p className="mb-2 text-[11px] text-text-muted dark:text-text-muted-dark">
                    {t('blockedHint')}
                </p>
                <div className="grid gap-2 md:grid-cols-2">
                    {AGENT_GUARDRAIL_ACTION_TYPES.map((actionType) => (
                        <Checkbox
                            key={actionType}
                            label={t(`actionTypes.${actionType}`)}
                            checked={blocked.includes(actionType)}
                            onChange={(event) => toggleBlocked(actionType, event.target.checked)}
                        />
                    ))}
                </div>
            </fieldset>

            <div className="flex flex-wrap items-center justify-end gap-2">
                {initial ? (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={reset}
                        disabled={isSubmitting}
                        className="gap-1.5 px-2.5 py-1 text-xs"
                    >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {t('reset')}
                    </Button>
                ) : null}
                <Button
                    onClick={save}
                    loading={isSubmitting}
                    size="sm"
                    className="gap-1.5 px-2.5 py-1 text-xs"
                >
                    <Save className="h-3.5 w-3.5" />
                    {t('save')}
                </Button>
            </div>
        </section>
    );
}
