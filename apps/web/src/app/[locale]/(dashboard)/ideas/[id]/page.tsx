import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AlertTriangle, ArrowLeft, Bot, CheckCircle2, ChevronRight, Lightbulb } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { workProposalsAPI } from '@/lib/api/work-proposals';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { STATUS_STYLES } from '@/components/ideas/idea-status';

/**
 * `/ideas/[id]` — Idea detail page.
 *
 * Server-fetches a single Idea via the existing
 * `GET /me/work-proposals/:id` endpoint (`workProposalsAPI.get`). An
 * unknown / unauthorized id resolves to `null` → Next.js `notFound()`
 * so the user sees the standard 404 instead of a half-rendered page.
 *
 * This is the destination for the full-card click target on `IdeaCard`
 * (home preview, `/ideas` catalog, Mission detail). It mirrors the
 * card's content (status badge, description, categories, suggested
 * plugins, reasoning, failure block) at full size and keeps the same
 * primary actions (Build / View Work, New Agent).
 */
type Params = Promise<{ id: string; locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
    const { id } = await params;
    const idea = await workProposalsAPI.get(id).catch(() => null);
    if (!idea) {
        const tPage = await getTranslations('dashboard.ideasPage');
        return { title: tPage('title') };
    }
    return { title: idea.title };
}

export default async function IdeaDetailPage({ params }: { params: Params }) {
    const { id } = await params;
    const idea = await workProposalsAPI.get(id).catch(() => null);
    if (!idea) {
        notFound();
    }

    const t = await getTranslations('dashboard.proposals');
    const tPage = await getTranslations('dashboard.ideasPage');

    // Mirror the card's Done heuristic: an accepted Idea that produced a
    // Work points its primary CTA at that Work instead of a new build.
    const isDone =
        idea.status === 'accepted' &&
        typeof idea.acceptedWorkId === 'string' &&
        idea.acceptedWorkId.length > 0;

    const statusStyle = STATUS_STYLES[idea.status] ?? STATUS_STYLES.pending;
    const buildHref = isDone
        ? ROUTES.DASHBOARD_WORK(idea.acceptedWorkId as string)
        : `/works/new?proposal=${idea.id}`;

    return (
        <div className="mx-auto w-full max-w-3xl p-6">
            {/* Back to the Ideas catalog. Reuses the existing page title
                key so no new i18n string is needed. */}
            <Link
                href={ROUTES.DASHBOARD_IDEAS}
                className="mb-6 inline-flex items-center gap-2 text-sm text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark transition-colors"
            >
                <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                {tPage('title')}
            </Link>

            <article
                className={cn(
                    'rounded-lg p-6',
                    'bg-card dark:bg-card-primary-dark/70',
                    'border border-card-border dark:border-white/10',
                    'shadow-sm dark:shadow-black/20',
                )}
            >
                {/* Status badge */}
                <div className="mb-4">
                    <span
                        className={cn(
                            'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset capitalize',
                            statusStyle.badge,
                        )}
                    >
                        <span
                            aria-hidden="true"
                            className={cn('h-1.5 w-1.5 rounded-full', statusStyle.dot)}
                        />
                        {tPage(`filters.${idea.status}`)}
                    </span>
                </div>

                <div className="mb-4 flex items-start gap-3">
                    <div className="shrink-0 w-10 h-10 rounded-lg bg-surface-secondary dark:bg-white/6 border border-border/50 dark:border-white/10 flex items-center justify-center">
                        <Lightbulb className="w-5 h-5 text-text-secondary dark:text-text-secondary-dark" />
                    </div>
                    <h1 className="min-w-0 text-2xl font-bold text-text dark:text-text-dark leading-tight">
                        {idea.title}
                    </h1>
                </div>

                <p className="whitespace-pre-wrap text-sm leading-6 text-text-secondary dark:text-text-secondary-dark">
                    {idea.description}
                </p>

                {idea.suggestedCategories.length > 0 && (
                    <div className="mt-5 flex flex-wrap gap-1.5">
                        {idea.suggestedCategories.map((cat) => (
                            <span
                                key={cat.slug}
                                className="inline-flex items-center rounded-full border border-border/60 dark:border-white/10 bg-surface-secondary/60 dark:bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-text-secondary dark:text-gray-300"
                            >
                                {cat.name}
                            </span>
                        ))}
                    </div>
                )}

                {idea.recommendedPlugins.length > 0 && (
                    <div className="mt-5 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('plugins.label')}:{' '}
                        <span className="text-text dark:text-text-dark font-medium">
                            {idea.recommendedPlugins.map((p) => p.pluginId).join(', ')}
                        </span>
                    </div>
                )}

                {idea.reasoning && (
                    <p className="mt-5 text-xs italic text-text-secondary dark:text-text-secondary-dark border-l-2 border-border/60 dark:border-white/10 pl-3">
                        &quot;{idea.reasoning}&quot;
                    </p>
                )}

                {/* Failure block — mirrors the card, un-clamped so the full
                    message is readable on the detail surface. */}
                {idea.status === 'failed' && (idea.failureMessage || idea.failureKind) && (
                    <div
                        role="alert"
                        className="mt-5 rounded-md border border-danger/30 bg-danger/5 dark:bg-danger/10 p-3 text-xs text-danger"
                    >
                        <div className="flex items-start gap-1.5">
                            <AlertTriangle
                                className="w-3.5 h-3.5 mt-0.5 shrink-0"
                                aria-hidden="true"
                            />
                            <div className="min-w-0 flex-1">
                                {idea.failureKind && (
                                    <div className="font-medium">
                                        {t(`failureKinds.${idea.failureKind}`)}
                                    </div>
                                )}
                                {idea.failureMessage && (
                                    <p className="mt-0.5 text-text-secondary dark:text-text-secondary-dark">
                                        {idea.failureMessage}
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* Primary actions — mirror the IdeaCard footer. Build (or
                    View Work when Done) + a quick on-ramp to an Idea-scoped
                    Agent. */}
                <div className="mt-6 flex items-center gap-2">
                    <Link
                        href={buildHref}
                        className={cn(
                            'flex-1 inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-white transition-colors active:scale-[0.98]',
                            isDone
                                ? 'bg-success hover:bg-success/90'
                                : 'bg-black hover:bg-black/80 dark:bg-white/6 dark:hover:bg-white/10',
                        )}
                    >
                        {isDone ? (
                            <>
                                <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                                {t('actions.viewWork')}
                            </>
                        ) : (
                            <>
                                {t('actions.accept')}
                                <ChevronRight className="w-4 h-4" aria-hidden="true" />
                            </>
                        )}
                    </Link>
                    <Link
                        href={`/ideas/${idea.id}/agents/new`}
                        className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-md border border-border dark:border-border-dark px-2.5 py-2 text-xs font-medium text-text-secondary dark:text-text-secondary-dark hover:border-primary/40 hover:text-primary dark:hover:text-primary transition-colors"
                        title="Create a new Idea-scoped Agent"
                    >
                        <Bot className="w-3.5 h-3.5" aria-hidden="true" />
                    </Link>
                </div>
            </article>
        </div>
    );
}
