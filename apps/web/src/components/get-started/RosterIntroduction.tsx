'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { acknowledgeRoster } from '@/app/actions/onboarding/roster';
import type { RosterAgentSummary } from '@/lib/api/onboarding';

export interface RosterIntroductionProps {
    readonly open: boolean;
    readonly agents: readonly RosterAgentSummary[];
    readonly onClose: () => void;
    /** Fires after a successful acknowledgement. */
    readonly onAcknowledged?: () => void;
}

/**
 * AW-20 P1 — "Meet your agents".
 *
 * Provisioning creating four rows is not the same as a person having met
 * four agents, and the platform must not claim the second from the first.
 * So **Got it** is what records the acknowledgement, and closing with
 * `Esc` or the backdrop deliberately does NOT: the panel is simply
 * offered again. Acknowledging twice is harmless — the server keeps the
 * first timestamp.
 */
export function RosterIntroduction({
    open,
    agents,
    onClose,
    onAcknowledged,
}: RosterIntroductionProps) {
    const t = useTranslations('onboarding.introduction');
    const [saving, setSaving] = useState(false);

    const coordinator = agents.find((agent) => agent.lane === 'coordination') ?? null;

    const confirm = async () => {
        setSaving(true);
        const result = await acknowledgeRoster();
        setSaving(false);
        if (result.success) onAcknowledged?.();
        onClose();
    };

    return (
        <Transition show={open}>
            <Dialog onClose={onClose} className="relative z-50">
                <TransitionChild
                    enter="ease-out duration-200"
                    enterFrom="opacity-0"
                    enterTo="opacity-100"
                    leave="ease-in duration-150"
                    leaveFrom="opacity-100"
                    leaveTo="opacity-0"
                >
                    <div className="fixed inset-0 bg-black/50 dark:bg-black/70" />
                </TransitionChild>

                <div className="fixed inset-0 overflow-y-auto p-4">
                    <div className="flex min-h-full items-center justify-center">
                        <TransitionChild
                            enter="ease-out duration-200"
                            enterFrom="opacity-0 scale-95"
                            enterTo="opacity-100 scale-100"
                            leave="ease-in duration-150"
                            leaveFrom="opacity-100 scale-100"
                            leaveTo="opacity-0 scale-95"
                        >
                            <DialogPanel
                                data-testid="roster-introduction"
                                className={cn(
                                    'w-full max-w-2xl rounded-xl p-6',
                                    'bg-white dark:bg-surface-dark shadow-xl',
                                )}
                            >
                                <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                                    {t('title')}
                                </DialogTitle>

                                {coordinator ? (
                                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                        {t('everyoneReportsTo', { name: coordinator.name })}
                                    </p>
                                ) : null}

                                <ul className="mt-4 space-y-3">
                                    {agents.map((agent) => (
                                        <li
                                            key={agent.id}
                                            data-testid={`roster-introduction-agent-${agent.id}`}
                                            className="rounded-lg border border-border dark:border-border-dark p-3"
                                        >
                                            <div className="flex items-baseline justify-between gap-3">
                                                <p className="text-sm font-semibold text-text dark:text-text-dark">
                                                    {agent.name}
                                                    {agent.title ? (
                                                        <span className="ml-2 text-xs font-normal text-text-muted dark:text-text-muted-dark">
                                                            {agent.title}
                                                        </span>
                                                    ) : null}
                                                </p>
                                                {agent.reportsToName ? (
                                                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                                        {t('reportsTo', {
                                                            name: agent.reportsToName,
                                                        })}
                                                    </span>
                                                ) : null}
                                            </div>
                                            {agent.skills.length > 0 ? (
                                                <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                                                    {t('skills', {
                                                        list: agent.skills.join(', '),
                                                    })}
                                                </p>
                                            ) : null}
                                        </li>
                                    ))}
                                </ul>

                                <p className="mt-4 flex items-start gap-2 text-xs text-text-muted dark:text-text-muted-dark">
                                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                                    {t('guardrailNotice')}
                                </p>

                                <div className="mt-5 flex justify-end">
                                    <Button
                                        size="sm"
                                        disabled={saving}
                                        data-testid="roster-introduction-got-it"
                                        onClick={() => void confirm()}
                                    >
                                        {saving ? (
                                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                        ) : null}
                                        {t('gotIt')}
                                    </Button>
                                </div>
                            </DialogPanel>
                        </TransitionChild>
                    </div>
                </div>
            </Dialog>
        </Transition>
    );
}
