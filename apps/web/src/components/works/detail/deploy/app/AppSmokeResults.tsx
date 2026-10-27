'use client';

import { useTranslations } from 'next-intl';
import { CheckCircle2, CircleSlash, XCircle } from 'lucide-react';
import type { AppSmokeCheckView, AppSmokeView } from '@/lib/api/app-runtime.types';
import { codeLeaf } from './app-ops-format';

export interface AppSmokeResultsProps {
    smoke: AppSmokeView | null | undefined;
    /** `snapshot.isolationEnforced` — `null` when the cluster could not tell. */
    isolationEnforced?: boolean | null;
}

/**
 * Lane aw-ops (APW-06 T38, FR-36/FR-37/FR-46) — the latest smoke results of the live Deployment:
 * in-cluster and public pass counts, the own-address (hairpin) check, network-isolation
 * enforcement, and every failing check with its classification. Visible to viewers too (S28).
 */
export function AppSmokeResults({ smoke, isolationEnforced }: AppSmokeResultsProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.smoke');

    const isolation =
        isolationEnforced === true
            ? t('isolation.enforced')
            : isolationEnforced === false
              ? t('isolation.notEnforced')
              : t('isolation.unknown');

    if (!smoke) {
        return (
            <div className="space-y-1 text-sm" data-testid="app-smoke-results">
                <p className="text-text-secondary">{t('none')}</p>
                <p className="text-xs text-text-secondary">{isolation}</p>
            </div>
        );
    }

    const failing = [
        ...smoke.inCluster,
        ...smoke.public,
        ...(smoke.hairpin ? [smoke.hairpin] : []),
    ].filter((check) => check.status === 'failed');

    return (
        <div
            className="space-y-1.5 text-sm"
            data-testid="app-smoke-results"
            data-failing={failing.length}
        >
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Half label={t('inCluster')} checks={smoke.inCluster} />
                <Half label={t('public')} checks={smoke.public} />
                {smoke.hairpin && (
                    <span className="inline-flex items-center gap-1">
                        <StatusIcon status={smoke.hairpin.status} />
                        {t('hairpin')}
                    </span>
                )}
                <span className="text-xs text-text-secondary">{isolation}</span>
            </p>
            {failing.length > 0 && (
                <ul className="space-y-0.5 text-xs" data-testid="app-smoke-failing">
                    {failing.map((check, index) => (
                        <li
                            key={`${check.name}-${index}`}
                            className="text-red-700 dark:text-red-400"
                        >
                            <code>{check.name}</code>
                            {' — '}
                            {describe(check, t)}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function Half({ label, checks }: { label: string; checks: AppSmokeCheckView[] }) {
    const t = useTranslations('dashboard.workDetail.appDeploy.smoke');
    const ran = checks.filter((check) => check.status !== 'skipped');
    const passed = ran.filter((check) => check.status === 'passed').length;
    const allPassed = ran.length > 0 && passed === ran.length;
    return (
        <span className="inline-flex items-center gap-1">
            <StatusIcon status={ran.length === 0 ? 'skipped' : allPassed ? 'passed' : 'failed'} />
            {t('count', { label, passed, total: ran.length })}
        </span>
    );
}

function StatusIcon({ status }: { status: AppSmokeCheckView['status'] }) {
    if (status === 'passed') {
        return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />;
    }
    if (status === 'failed') {
        return <XCircle className="h-3.5 w-3.5 text-red-600" aria-hidden="true" />;
    }
    return <CircleSlash className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />;
}

function describe(check: AppSmokeCheckView, t: ReturnType<typeof useTranslations>): string {
    const known = ['dns_not_pointing', 'tls_not_ready', 'unreachable', 'check_failed'];
    if (check.classification && known.includes(check.classification)) {
        return t(`classifications.${codeLeaf(check.classification)}`);
    }
    if (check.failedExpectation) return check.failedExpectation;
    if (typeof check.httpStatus === 'number') return t('httpStatus', { status: check.httpStatus });
    return t('failed');
}
