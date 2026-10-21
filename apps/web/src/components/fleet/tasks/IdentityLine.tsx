'use client';

import { useTranslations } from 'next-intl';
import { fleetGitIdentityIncomplete } from '@ever-works/contracts';
import { UseMyIdentityButton } from '../git/UseMyIdentityButton';
import { useGitIdentity } from '../git/use-git-identity';

/**
 * Tasks on computers (FL-15 P2, spec FR-16, ACC-FL15-17) — the dialog's
 * "Git on <computer>" line for the selected computer: name ✓ · email ✓ ·
 * Ever Works can push for agents ✓, and **Use my Ever Works identity** inline
 * when name or email is unset. A computer that cannot answer (no `--manage`,
 * offline) says so in one muted line and never blocks the start.
 */
export function IdentityLine({ nodeId, nodeName }: { nodeId: string; nodeName: string }) {
    const t = useTranslations('fleet.gitIdentity.line');
    const { state, replace } = useGitIdentity(nodeId);
    const mark = (ok: boolean) => (ok ? '✓' : '⚠');

    if (state.kind === 'loading') {
        return <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('loading', { node: nodeName })}</p>;
    }
    if (state.kind === 'error') {
        return (
            <p className="text-xs text-text-muted dark:text-text-muted-dark" data-testid="fleet-handoff-identity">
                {state.code === 'consent_missing' ? t('needsManage', { node: nodeName }) : t('unknown', { node: nodeName })}
            </p>
        );
    }
    const identity = state.identity;
    return (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="fleet-handoff-identity">
            <span>
                {t('summary', {
                    node: nodeName,
                    name: mark(identity.name.set),
                    email: mark(identity.email.set),
                    push: mark(identity.canPushForAgents.ok),
                })}
            </span>
            {fleetGitIdentityIncomplete(identity) && <UseMyIdentityButton nodeId={nodeId} onDone={replace} />}
        </div>
    );
}
