'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { parseKbCitations } from '@/lib/kb/parse-kb-citations';
import { cn } from '@/lib/utils/cn';
import { KbCitationHover } from './KbCitationHover';

/**
 * EW-641 Phase 2/c row 35e — "Cited:" footer rendered below the
 * assistant message's Markdown body. Detects `kb:{class}/{slug}`
 * tokens via row 35a's parser (web port — row 35d) and shows each
 * referenced doc once as a `<KbCitationHover>` chip.
 *
 * Why a footer instead of inlining citations inside Markdown:
 *  - `ChatMessageContent` already renders `<ChatMarkdown>` which
 *    runs `react-markdown` + `remark-gfm`. Mutating the text before
 *    passing it through would wrap citations inside code fences too
 *    (false positives in `\`\`\`bash\\nkb:brand/voice\\n\`\`\``-style
 *    blocks).
 *  - A remark plugin would dodge the code-fence problem but adds a
 *    new dependency surface; row 35e ships the simplest correct
 *    thing.
 *  - The footer surfaces every cited doc *once* (dedup by cls/slug)
 *    so a chatty assistant citing the same doc 5 times still gets
 *    a single chip — easier to scan.
 *
 * Renders nothing if no citations are present or if the parsed
 * citation list is empty — drop-in safe in any assistant-message
 * render path.
 *
 * Selectors locked for future e2e:
 *  - `kb-citation-footer` (root, `data-citation-count={n}`),
 *  - inner chips reuse row 35c `<KbCitationHover>` selectors
 *    (`kb-citation-hover` etc.).
 */

export interface KbCitationFooterProps {
    /** Plain text of the assistant message (full body — same string
     *  passed to ChatMarkdown). */
    text: string;
    /** Owning Work scope for citation resolution. */
    workId: string;
}

interface UniqueCitation {
    readonly cls: Parameters<typeof KbCitationHover>[0]['cls'];
    readonly slug: string;
    readonly raw: string;
    readonly key: string;
}

export function KbCitationFooter({ text, workId }: KbCitationFooterProps) {
    const t = useTranslations('dashboard.workDetail.kb.citation');

    const uniqueCitations = useMemo<UniqueCitation[]>(() => {
        const raw = parseKbCitations(text);
        if (raw.length === 0) return [];
        const seen = new Set<string>();
        const out: UniqueCitation[] = [];
        for (const c of raw) {
            const dedupKey = `${c.cls}/${c.slug}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            out.push({
                cls: c.cls,
                slug: c.slug,
                raw: c.raw,
                key: dedupKey,
            });
        }
        return out;
    }, [text]);

    if (uniqueCitations.length === 0) return null;

    return (
        <div
            data-testid="kb-citation-footer"
            data-citation-count={uniqueCitations.length}
            className={cn(
                'mt-2 flex flex-wrap items-center gap-1.5 border-t pt-2 text-[11px]',
                'border-border/40 dark:border-white/10',
                'text-text-muted dark:text-text-muted-dark',
            )}
        >
            <span className="font-medium">{t('citedLabel')}</span>
            {uniqueCitations.map((c) => (
                <KbCitationHover
                    key={c.key}
                    workId={workId}
                    cls={c.cls}
                    slug={c.slug}
                    raw={c.raw}
                />
            ))}
        </div>
    );
}
