'use client';

import { useTranslations } from 'next-intl';
import { Check, GitBranch, RefreshCw, TriangleAlert } from 'lucide-react';
import { fleetGitIdentityIncomplete, type FleetGitIdentityField, type FleetNodeView } from '@ever-works/contracts';
import { UseMyIdentityButton } from './UseMyIdentityButton';
import { useGitIdentity } from './use-git-identity';

function Mark({ ok }: { ok: boolean }) {
    return ok ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
    ) : (
        <TriangleAlert className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
    );
}

/**
 * Tasks on computers (FL-15 P2, spec FR-12, FR-13, S7, §5.4) — **Git on
 * <computer>** on the computer's Settings tab: the global `user.name`,
 * `user.email` and credential helper (values for the owner, set / unset for
 * everyone else — the platform masks them), whether Ever Works can push for
 * agents there and why not, and, for the owner when name or email is unset,
 * **Use my Ever Works identity**. Needs `--manage` on the computer.
 */
export function GitIdentityCard({ node }: { node: Pick<FleetNodeView, 'id' | 'name' | 'viewerRole'> }) {
    const t = useTranslations('fleet.gitIdentity');
    const { state, refresh, replace } = useGitIdentity(node.id);
    const isOwner = node.viewerRole === undefined || node.viewerRole === 'owner';

    const valueOf = (field: FleetGitIdentityField) =>
        field.value ?? (field.set ? t('card.set') : t('card.notSet'));

    return (
        <section className="space-y-3" data-testid="fleet-git-identity-card">
            <div className="flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-text dark:text-text-dark">
                    <GitBranch className="h-4 w-4" aria-hidden="true" />
                    {t('card.title', { node: node.name })}
                </h3>
                <button
                    type="button"
                    onClick={refresh}
                    className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text dark:hover:text-text-dark"
                    data-testid="fleet-git-identity-refresh"
                >
                    <RefreshCw className="h-3 w-3" aria-hidden="true" />
                    {t('card.refresh')}
                </button>
            </div>
            {state.kind === 'loading' && <p className="text-sm text-text-muted">{t('card.loading')}</p>}
            {state.kind === 'error' && (
                <p className="text-sm text-text-muted dark:text-text-muted-dark" role="status">
                    {state.code === 'consent_missing'
                        ? t('errors.needsManage', { node: node.name })
                        : (state.hint ?? t('errors.readFailed'))}
                </p>
            )}
            {state.kind === 'ready' && (
                <>
                    <dl className="grid grid-cols-[6rem_1fr_auto] gap-x-3 gap-y-1.5 text-sm">
                        <dt className="text-text-muted">{t('card.name')}</dt>
                        <dd className="truncate" data-testid="fleet-git-identity-name">
                            {valueOf(state.identity.name)}
                        </dd>
                        <dd>
                            <Mark ok={state.identity.name.set} />
                        </dd>
                        <dt className="text-text-muted">{t('card.email')}</dt>
                        <dd className="truncate font-mono text-xs" data-testid="fleet-git-identity-email">
                            {valueOf(state.identity.email)}
                        </dd>
                        <dd>
                            <Mark ok={state.identity.email.set} />
                        </dd>
                        <dt className="text-text-muted">{t('card.helper')}</dt>
                        <dd className="truncate">
                            {state.identity.helper.value ??
                                (state.identity.helper.present ? t('card.set') : t('card.none'))}
                        </dd>
                        <dd>
                            <Mark ok={state.identity.helper.present} />
                        </dd>
                    </dl>
                    <p className="text-sm" data-testid="fleet-git-identity-push">
                        {state.identity.canPushForAgents.ok
                            ? t('card.canPushYes', {
                                  repositories: (state.identity.canPushForAgents.repositories ?? []).join(', '),
                              })
                            : t('card.canPushNo', { reason: state.identity.canPushForAgents.reason ?? '' })}
                    </p>
                    {isOwner && (
                        <div className="flex flex-wrap items-center gap-2">
                            <UseMyIdentityButton nodeId={node.id} onDone={replace} />
                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                {fleetGitIdentityIncomplete(state.identity)
                                    ? t('card.fixHintIncomplete')
                                    : t('card.fixHint')}
                            </span>
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
