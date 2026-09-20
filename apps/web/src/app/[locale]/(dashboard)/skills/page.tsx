import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import { buildSkillsHref, parseSkillsSearchParams } from '@/lib/skills-page-data';
import { ROUTES } from '@/lib/constants';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * `/skills` (index) — retired as a standalone page (navigation consolidation,
 * docs/specs/features/navigation-consolidation): nobody browses Skills without
 * an Agent in mind, so the catalog lives inside the Agents hub.
 *
 * WHERE it lives has changed twice. First it was a `#skills` anchor block at the
 * bottom of `/agents`; the Activity merge then gave it a sub-tab of its own,
 * `/agents/skills`, alongside Agents and Activity. This redirect follows it, and
 * so does every bookmark, deep link, doc and e2e journey written against the old
 * shape.
 *
 * Kept as a redirect rather than deleted, and it still carries the filters:
 * `/skills?section=custom` lands on `/agents/skills?section=custom`.
 * `/skills/new`, `/skills/[id]` and `/skills/templates` are unchanged.
 */
export default async function SkillsIndexRedirect({
    searchParams,
}: {
    searchParams?: Promise<SearchParams>;
}) {
    const filters = parseSkillsSearchParams((await searchParams) ?? {});
    const locale = await getLocale();
    redirect({ href: buildSkillsHref(ROUTES.DASHBOARD_AGENTS_SKILLS, filters), locale });
}
