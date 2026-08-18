import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import { buildSkillsHref, parseSkillsSearchParams } from '@/lib/skills-page-data';
import { ROUTES } from '@/lib/constants';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * `/skills` (index) — retired as a standalone page (navigation consolidation,
 * docs/specs/features/navigation-consolidation): the Skills catalog now renders
 * as a block on the Agents tab, because nobody browses Skills without an Agent
 * in mind.
 *
 * Kept as a redirect rather than deleted so every bookmark, deep link, doc and
 * e2e journey keeps working; the filters ride along so `/skills?section=custom`
 * lands on `/agents?section=custom#skills`. `/skills/new`, `/skills/[id]` and
 * `/skills/templates` are unchanged.
 */
export default async function SkillsIndexRedirect({
    searchParams,
}: {
    searchParams?: Promise<SearchParams>;
}) {
    const filters = parseSkillsSearchParams((await searchParams) ?? {});
    const locale = await getLocale();
    redirect({ href: buildSkillsHref(ROUTES.DASHBOARD_AGENTS, filters, '#skills'), locale });
}
