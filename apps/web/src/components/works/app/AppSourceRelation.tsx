'use client';

import { useTranslations } from 'next-intl';
import { GitFork, Link2, Lock } from 'lucide-react';
import type { AppSourceRelationSummary } from '@/lib/works/app-source-relation';

const meta =
    'flex items-center gap-1 text-[11px] text-text-secondary dark:text-text-secondary-dark';

function RepoLink({ label, href }: { label: string; href?: string }) {
    if (!href) return <span>{label}</span>;
    return (
        <a href={href} target="_blank" rel="noreferrer noopener" className="hover:underline">
            {label}
        </a>
    );
}

/**
 * APW-01 T24 — the App Work header's relation line (spec §6.4), right after the
 * **App** chip: `Fork: me/app · Upstream: acme/app`, `Private copy: …`, or
 * `Linked: acme/app`.
 */
export function AppSourceRelation({ summary }: { summary: AppSourceRelationSummary }) {
    const t = useTranslations('dashboard.workDetail.appSource.relation');
    const Icon = summary.relation === 'link' ? Link2 : summary.relation === 'fork' ? GitFork : Lock;

    return (
        <div className="flex flex-wrap items-center gap-3" data-testid="app-source-relation">
            <span className={meta}>
                <Icon className="w-3.5 h-3.5 opacity-60" aria-hidden="true" />
                <RepoLink
                    label={t(summary.relation, { fullName: summary.repository })}
                    href={summary.repositoryUrl}
                />
            </span>
            {summary.upstream && (
                <span className={meta} data-testid="app-source-relation-upstream">
                    <RepoLink
                        label={t('upstream', { fullName: summary.upstream })}
                        href={summary.upstreamUrl}
                    />
                </span>
            )}
        </div>
    );
}
