'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { getWebBuildInfo } from '@/lib/build-info';
import { ROUTES } from '@/lib/constants';
import { suggestHelpArticles } from '@/lib/help/help-target';

/**
 * `/help/<slug>` for an article this build does not contain (AW-25, spec
 * S-14, §6.8). Never a generic 404 and never a redirect to a different
 * article: it names the running version, offers up to three near titles
 * from this build, and always offers the whole manual.
 */
export function HelpArticleNotInBuild({ slug }: { slug: string }) {
    const t = useTranslations('dashboard.helpCenter.notInBuild');
    const build = getWebBuildInfo();
    const knownVersion = build.version && build.version !== '0.0.0';
    const suggestions = suggestHelpArticles(slug, 3);

    return (
        <div data-testid="help-not-in-build" className="mx-auto max-w-2xl space-y-5 py-10">
            <h1 className="text-2xl font-semibold text-text dark:text-text-dark">{t('title')}</h1>
            <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                {knownVersion ? t('body', { version: build.version }) : t('bodyUnknownVersion')}
            </p>
            {suggestions.length > 0 && (
                <section aria-labelledby="help-not-in-build-suggestions" className="space-y-2">
                    <h2
                        id="help-not-in-build-suggestions"
                        className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark"
                    >
                        {t('suggestions')}
                    </h2>
                    <ul className="space-y-1">
                        {suggestions.map((article) => (
                            <li key={article.id}>
                                <Link
                                    href={ROUTES.DASHBOARD_HELP_ARTICLE(article.id)}
                                    className="text-sm text-primary hover:underline dark:text-primary-dark"
                                >
                                    {article.title}
                                </Link>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            <Link
                href={ROUTES.DASHBOARD_HELP}
                data-testid="help-browse-all"
                className="inline-flex items-center rounded-lg border border-border px-4 py-2 text-sm font-medium text-text hover:bg-surface dark:border-border-dark dark:text-text-dark dark:hover:bg-surface-secondary-dark"
            >
                {t('browseAll')}
            </Link>
        </div>
    );
}
