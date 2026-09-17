import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { HelpArticleNotInBuild } from '@/components/help/HelpArticleNotInBuild';
import { HelpArticlePage } from '@/components/help/HelpArticlePage';
import { getHelpArticle } from '@/lib/help/help-target';

type Params = Promise<{ slug: string; locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
    const { slug } = await params;
    const t = await getTranslations('metadata.pages');
    const article = getHelpArticle(slug);
    return { title: article ? `${article.title} · ${t('help')}` : t('help') };
}

/**
 * Help centre (AW-25) — `/help/<article>`: one article as a full, shareable
 * page. An article this build does not contain renders the "not in this
 * build" page with a 200 — deliberately not `notFound()` and never a redirect
 * to a different article (spec S-14).
 */
export default async function HelpArticleRoute({ params }: { params: Params }) {
    const { slug } = await params;
    const article = getHelpArticle(slug);
    if (!article) return <HelpArticleNotInBuild slug={slug} />;
    return <HelpArticlePage articleId={article.id} />;
}
