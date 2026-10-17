'use client';

import { useTranslations } from 'next-intl';
import type { AppSourceInspectResponse } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { formatRepositorySizeKb } from '@/lib/work-kinds/app-source-reasons';

/** The preview shows the size line only above 100 MB (spec §6.2). */
export const APP_PREVIEW_LARGE_REPOSITORY_KB = 100 * 1024;

/** Which Blueprint badge the preview carries (spec §6.2). */
export function blueprintBadgeKey(
    blueprint: AppSourceInspectResponse['blueprint'],
): 'verified' | 'available' | 'none' | 'unavailable' {
    if (blueprint.status === 'matched') return blueprint.verified ? 'verified' : 'available';
    if (blueprint.status === 'unavailable') return 'unavailable';
    return 'none';
}

/**
 * The pasted repository is the member's own fork: a fork they can push to
 * (spec §6.2 "Own fork", FR-18). Ever Works then follows its parent upstream.
 */
export function isOwnFork(preview: AppSourceInspectResponse): boolean {
    return preview.repository.isFork && preview.access.canPush;
}

const chip = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium';

/**
 * APW-01 T22 — the preview card's header (spec §6.2): repository facts, the
 * license chip with its R-3 hosting class, the Blueprint badge, and the notes
 * that only apply to some repositories (moved, a fork, archived, large).
 */
export function AppSourcePreviewCard({ preview }: { preview: AppSourceInspectResponse }) {
    const t = useTranslations('dashboard.workCreation.app');
    const { repository, license, blueprint } = preview;
    const parent = repository.parent ?? repository.source;
    const badge = blueprintBadgeKey(blueprint);

    return (
        <div className="space-y-2" data-testid="app-work-preview">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <a
                    href={repository.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-base font-semibold text-text dark:text-text-dark hover:underline"
                    data-testid="app-work-preview-name"
                >
                    {repository.fullName}
                </a>
                <span className="text-xs text-text-secondary dark:text-text-secondary-dark">
                    ★ {t('stars', { count: repository.stars })}
                </span>
                <span className="text-xs text-text-secondary dark:text-text-secondary-dark">
                    {t('defaultBranch', { branch: repository.defaultBranch })}
                </span>
                {repository.sizeKb > APP_PREVIEW_LARGE_REPOSITORY_KB && (
                    <span className="text-xs text-text-secondary dark:text-text-secondary-dark">
                        {t('largeRepository', { size: formatRepositorySizeKb(repository.sizeKb) })}
                    </span>
                )}
            </div>
            {repository.description && (
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    {repository.description}
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                <span
                    className={cn(
                        chip,
                        license.class === 'green'
                            ? 'border-emerald-300 text-emerald-700 dark:text-emerald-300'
                            : license.class === 'unknown'
                              ? 'border-gray-300 text-text-secondary'
                              : 'border-amber-300 text-amber-700 dark:text-amber-300',
                    )}
                    data-testid="app-work-license"
                >
                    {license.spdx
                        ? t('licenseChip', { spdx: license.spdx })
                        : t('licenseNotDetected')}
                    {' · '}
                    {t(`licenseClass.${license.class}`)}
                </span>
                <span
                    className={cn(
                        chip,
                        badge === 'verified' || badge === 'available'
                            ? 'border-sky-300 text-sky-700 dark:text-sky-300'
                            : 'border-gray-300 text-text-secondary',
                    )}
                    data-testid="app-work-blueprint-badge"
                >
                    {t(`blueprintBadge.${badge}`)}
                    {blueprint.status === 'matched' && blueprint.name ? ` · ${blueprint.name}` : ''}
                </span>
            </div>
            {blueprint.status === 'matched' && blueprint.notice && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {blueprint.notice}
                </p>
            )}
            <ul className="space-y-1 text-xs text-text-secondary dark:text-text-secondary-dark">
                {repository.movedFrom && <li>{t('moved', { fullName: repository.fullName })}</li>}
                {repository.isFork && parent && (
                    <li data-testid="app-work-fork-note">
                        {isOwnFork(preview) ? t('ownFork', { parent }) : t('isFork', { parent })}
                    </li>
                )}
                {repository.archived && <li>{t('archivedNote')}</li>}
                {preview.scanIncomplete && <li>{t('scanIncomplete')}</li>}
            </ul>
            {preview.existingAppWork && (
                <p
                    className="text-sm text-text dark:text-text-dark"
                    data-testid="app-work-existing"
                >
                    {t('existingAppWork', { name: preview.existingAppWork.name })}{' '}
                    <Link
                        href={ROUTES.DASHBOARD_WORK(preview.existingAppWork.id)}
                        className="font-medium underline"
                    >
                        {t('openExistingAppWork')}
                    </Link>
                </p>
            )}
        </div>
    );
}
