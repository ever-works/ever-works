'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { captureHelpEvent } from '@/lib/help/help-telemetry';
import { decodeHelpFragment, getHelpArticle, parseHelpTarget } from '@/lib/help/help-target';
import { helpArticleHref } from './HelpArticleBlocks';
import { HelpArticleReader } from './HelpArticleReader';
import { HelpBuildStamp } from './HelpBuildStamp';

function readHash(): string | null {
    if (typeof window === 'undefined') return null;
    return decodeHelpFragment(window.location.hash);
}

/**
 * `/help/<article>` — one article of the manual as a full page (AW-25, spec
 * S-7, FR-21). The URL fragment names the heading to open at; a fragment this
 * build's article does not have opens the article at its top with the
 * "section has moved" line (spec S-15).
 */
export function HelpArticlePage({ articleId }: { articleId: string }) {
    const router = useRouter();
    const article = getHelpArticle(articleId);
    const [headingId, setHeadingId] = useState<string | null>(null);

    useEffect(() => {
        const initial = readHash();
        setHeadingId(initial);
        if (article) {
            captureHelpEvent({
                name: 'help_article_opened',
                properties: {
                    article_id: article.id,
                    section: article.section,
                    source: 'url',
                    via_heading: initial !== null,
                },
            });
        }
        const onHashChange = () => setHeadingId(readHash());
        window.addEventListener('hashchange', onHashChange);
        return () => window.removeEventListener('hashchange', onHashChange);
        // The article is fixed for the life of this page.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const openArticle = useCallback(
        (target: string) => {
            const parsed = parseHelpTarget(target);
            if (!parsed) return;
            if (parsed.articleId === articleId && parsed.headingId) {
                window.location.hash = parsed.headingId;
                return;
            }
            router.push(helpArticleHref(target));
        },
        [articleId, router],
    );

    if (!article) return null;

    return (
        <div className="mx-auto max-w-3xl space-y-8">
            <HelpArticleReader
                key={headingId ?? ''}
                article={article}
                headingId={headingId}
                mode="page"
                onOpenArticle={openArticle}
            />
            <HelpBuildStamp className="border-t border-border pt-4 dark:border-border-dark" />
        </div>
    );
}
