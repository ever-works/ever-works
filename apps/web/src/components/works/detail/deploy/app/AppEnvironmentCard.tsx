'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { KeyRound, Lock, Pencil, Plug } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { getAppEnvAction } from '@/app/actions/dashboard/app-env';
import {
    APP_ENV_ROUTE_UNAVAILABLE,
    isAppEnvDependencyKindLeaf,
    type AppEnvListResponse,
    type AppEnvPatchResponse,
    type AppEnvVariableView,
} from '@/lib/api/app-env.types';
import { cn } from '@/lib/utils/cn';
import { AppEnvValueDialog } from './AppEnvValueDialog';

type CardState =
    | { kind: 'loading' }
    | { kind: 'ready'; env: AppEnvListResponse }
    | { kind: 'unavailable' }
    | { kind: 'error' };

export interface AppEnvironmentCardProps {
    workId: string;
    /** First paint from the server, or `null` when it could not be read there. */
    initialEnv?: AppEnvListResponse | null;
}

/**
 * Lane aw-env-smtp (APW-07 T24) — the **Environment** card on an App Work's Deploy tab.
 *
 * Every variable the App spec declares — prompted, generated, literal and dependency-injected — with
 * whether it is set, never a secret's value (FR-5). A required value that is missing is what refuses a
 * Deploy with `env_required_unset`, so those rows come first and are marked; **Edit** opens
 * {@link AppEnvValueDialog} (members with edit access only). A `deps.*` row says which dependency
 * injects it: a value set there overrides the dependency — e.g. your own SMTP server instead of the
 * in-namespace mail sink.
 */
export function AppEnvironmentCard({ workId, initialEnv = null }: AppEnvironmentCardProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.environment');
    const [state, setState] = useState<CardState>(
        initialEnv ? { kind: 'ready', env: initialEnv } : { kind: 'loading' },
    );
    const [editing, setEditing] = useState<AppEnvVariableView | null>(null);

    const load = useCallback(async () => {
        try {
            const result = await getAppEnvAction(workId);
            if (result.success && result.data) setState({ kind: 'ready', env: result.data });
            else if (result.code === APP_ENV_ROUTE_UNAVAILABLE) setState({ kind: 'unavailable' });
            else setState({ kind: 'error' });
        } catch {
            setState({ kind: 'error' });
        }
    }, [workId]);

    useEffect(() => {
        if (!initialEnv) void load();
    }, [initialEnv, load]);

    const onSaved = (answer: AppEnvPatchResponse, action: 'saved' | 'removed') => {
        setState((previous) =>
            previous.kind === 'ready'
                ? { kind: 'ready', env: { ...previous.env, entries: answer.entries } }
                : previous,
        );
        const name = answer.changed[0] ?? editing?.name ?? '';
        toast.success(action === 'removed' ? t('removed', { name }) : t('saved', { name }));
        // The summary counts come from the server; re-read them rather than re-derive them here.
        void load();
    };

    if (state.kind !== 'ready') {
        return (
            <section
                className="rounded-lg border border-card-border p-4 text-sm text-text-secondary"
                data-testid="app-env-card"
            >
                {state.kind === 'loading'
                    ? t('loading')
                    : state.kind === 'unavailable'
                      ? t('unavailable')
                      : t('error')}
            </section>
        );
    }

    const env = state.env;
    const missing = env.entries.filter((entry) => entry.required && !entry.set);
    const entries = [...env.entries].sort((left, right) => {
        const leftMissing = left.required && !left.set ? 0 : 1;
        const rightMissing = right.required && !right.set ? 0 : 1;
        return leftMissing - rightMissing;
    });

    return (
        <section
            className={cn(
                'rounded-lg border p-4 space-y-3',
                missing.length > 0
                    ? 'border-amber-300 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-900/10'
                    : 'border-card-border dark:border-border-secondary-dark',
            )}
            aria-labelledby="app-env-card-title"
            data-testid="app-env-card"
            data-missing={missing.length}
        >
            <div className="flex items-start gap-2">
                <KeyRound className="mt-0.5 h-4 w-4 text-text-secondary" aria-hidden="true" />
                <div className="space-y-1">
                    <h3
                        id="app-env-card-title"
                        className="text-sm font-semibold text-text dark:text-text-dark"
                    >
                        {t('title')}
                    </h3>
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                        {t('description')}
                    </p>
                    <p className="text-xs text-text-secondary" data-testid="app-env-summary">
                        {t('summary', { set: env.summary.set, total: env.summary.total })}
                        {missing.length > 0 && (
                            <>
                                {' · '}
                                <span className="font-medium text-amber-700 dark:text-amber-400">
                                    {t('missingRequired', { count: missing.length })}
                                </span>
                            </>
                        )}
                    </p>
                </div>
            </div>

            {!env.secureStorage && (
                <p
                    className="text-xs text-red-600 dark:text-red-400"
                    role="alert"
                    data-testid="app-env-no-storage"
                >
                    {t('secureStorageOff')}
                </p>
            )}

            {entries.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('empty')}</p>
            ) : (
                <ul
                    className="divide-y divide-card-border dark:divide-white/9"
                    data-testid="app-env-list"
                >
                    {entries.map((entry) => (
                        <EnvRow
                            key={entry.name}
                            entry={entry}
                            canEdit={env.canEdit && env.secureStorage}
                            onEdit={() => setEditing(entry)}
                        />
                    ))}
                </ul>
            )}

            {editing && (
                <AppEnvValueDialog
                    open={editing !== null}
                    onOpenChange={(open) => {
                        if (!open) setEditing(null);
                    }}
                    workId={workId}
                    entry={editing}
                    onSaved={onSaved}
                />
            )}
        </section>
    );
}

function EnvRow({
    entry,
    canEdit,
    onEdit,
}: {
    entry: AppEnvVariableView;
    canEdit: boolean;
    onEdit: () => void;
}) {
    const t = useTranslations('dashboard.workDetail.appDeploy.environment');
    const missing = entry.required && !entry.set;
    const kind = entry.dependency?.kind;
    const kindLabel = isAppEnvDependencyKindLeaf(kind) ? t(`kinds.${kind}`) : kind;

    const stateLabel = missing
        ? t('states.missing')
        : entry.set
          ? entry.origin === 'generated' || entry.origin === 'derived'
              ? t('states.generated')
              : t('states.set')
          : entry.dependency
            ? t('states.fromDependency', { kind: kindLabel ?? '' })
            : entry.source === 'value' || entry.source === 'from' || entry.source === 'template'
              ? t('states.fromSpec')
              : t('states.unset');

    return (
        <li
            className="flex flex-wrap items-center justify-between gap-2 py-2"
            data-testid="app-env-row"
            data-name={entry.name}
            data-set={entry.set ? 'true' : 'false'}
        >
            <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                    <code className="break-all text-xs font-semibold text-text dark:text-text-dark">
                        {entry.name}
                    </code>
                    {entry.masked && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-surface-tertiary px-1.5 text-[10px] text-text-secondary dark:bg-surface-tertiary-dark">
                            <Lock className="h-2.5 w-2.5" aria-hidden="true" />
                            {t('badges.secret')}
                        </span>
                    )}
                    {entry.required && (
                        <span className="rounded bg-surface-tertiary px-1.5 text-[10px] text-text-secondary dark:bg-surface-tertiary-dark">
                            {t('badges.required')}
                        </span>
                    )}
                    <span className="rounded border border-card-border px-1.5 text-[10px] text-text-muted dark:border-white/9">
                        {t(`phases.${entry.phase}`)}
                    </span>
                    {entry.dependency && (
                        <span className="inline-flex items-center gap-0.5 rounded border border-card-border px-1.5 text-[10px] text-text-muted dark:border-white/9">
                            <Plug className="h-2.5 w-2.5" aria-hidden="true" />
                            {kindLabel}
                        </span>
                    )}
                </div>
                <p
                    className={cn(
                        'text-xs',
                        missing
                            ? 'font-medium text-amber-700 dark:text-amber-400'
                            : 'text-text-secondary',
                    )}
                    data-testid="app-env-row-state"
                >
                    {stateLabel}
                    {entry.description ? ` — ${entry.description}` : ''}
                </p>
            </div>
            {canEdit && entry.editable && (
                <Button
                    type="button"
                    size="sm"
                    variant={missing ? 'primary' : 'ghost'}
                    onClick={onEdit}
                    data-testid="app-env-edit"
                    aria-label={t('editAria', { name: entry.name })}
                >
                    <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                    {entry.set ? t('edit') : t('setValue')}
                </Button>
            )}
        </li>
    );
}
