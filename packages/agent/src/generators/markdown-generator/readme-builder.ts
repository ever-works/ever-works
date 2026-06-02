import GithubSlugger from 'github-slugger';
import type { ItemData } from '@ever-works/plugin';

export class ReadmeBuilder {
    private content: string = '';
    private isTocEnabled: boolean = false;
    private readonly toc: { header: string; count?: number }[] = []; // Table of Contents

    constructor(
        private readonly header: string,
        private readonly footer: string,
    ) {}

    addHeader(header: string) {
        this.content += `# ${header}\n\n`;
        return this;
    }

    addSubHeader(header: string, count?: number) {
        this.content += `## ${header}\n\n`;
        this.toc.push({ header, count });
        return this;
    }

    addParagraph(paragraph: string) {
        this.content += `${paragraph}\n\n`;
        return this;
    }

    addNewLine() {
        this.content += '\n';
        return this;
    }

    enableToC() {
        this.isTocEnabled = true;
        return this;
    }

    private generateToC() {
        let toc = '';

        if (this.isTocEnabled) {
            // Fresh slugger per ToC build. `GithubSlugger` is stateful —
            // it tracks every slug it has ever produced to enforce
            // intra-document uniqueness. A module-scoped or per-instance
            // slugger reused across multiple READMEs would gradually
            // suffix headers (`tools`, `tools-1`, `tools-2`, ...) while
            // GitHub Markdown re-renders each `## Tools` header back to
            // anchor `#tools` — every TOC link past the first would
            // become a dead anchor.
            const slugger = new GithubSlugger();
            toc += '## 📑 Table of Contents\n\n';
            this.toc.forEach(({ header, count }) => {
                const slug = slugger.slug(header);
                let label = header;
                if (count !== undefined) {
                    label += ` (${count.toLocaleString('en-US')})`;
                }
                toc += `- [${label}](#${slug})\n`;
            });
            toc += '\n';
        }

        return toc;
    }

    // Security: README.md is committed verbatim to the user's (often public)
    // GitHub repo, and `item.name`/`description`/`source_url`/tag names are
    // populated by the AI pipeline from externally-fetched, attacker-controllable
    // web content. Escape Markdown control characters in text fields and validate
    // the link target so a hostile page title/description/URL cannot inject extra
    // links or break out of the list-item / inline-code context. Benign values
    // (plain titles, descriptions, http(s) URLs) are left byte-for-byte unchanged.
    private escapeMarkdownInline(value: string): string {
        return String(value ?? '').replace(/[\\`[\]]/g, '\\$&');
    }

    // Security: only emit `http(s)` link targets; anything else (e.g.
    // `javascript:`/`data:` URIs) collapses to an inert anchor. For accepted
    // URLs, percent-encode the few characters that would otherwise terminate or
    // break out of the Markdown link destination `(...)`. Legitimate http(s)
    // URLs do not contain these characters, so they pass through verbatim.
    private sanitizeMarkdownUrl(value: string): string {
        const raw = String(value ?? '');
        let parsed: URL;
        try {
            parsed = new URL(raw);
        } catch {
            return '#';
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return '#';
        }
        return raw.replace(/[()<>\s]/g, encodeURIComponent);
    }

    addItem(item: ItemData, options: { hasDetails?: boolean } = {}) {
        // TODO: consider making featured items bolder (item.featured)
        const name = this.escapeMarkdownInline(item.name);
        const url = this.sanitizeMarkdownUrl(item.source_url);
        const description = this.escapeMarkdownInline(item.description);
        this.content += `- [${name}](${url}) - ${description}`;
        if (options.hasDetails) {
            this.content += ` ([Read more](/details/${item.slug}.md))`;
        }

        if (item.tags && item.tags.length > 0) {
            const tags = item.tags
                .map(
                    (tag) =>
                        `\`${this.escapeMarkdownInline((tag as { name?: string }).name ?? String(tag))}\``,
                )
                .join(' ');
            this.content += ` ${tags}`;
        }
        this.content += '\n';
        return this;
    }

    build(): string {
        let result = this.header + '\n';

        if (this.isTocEnabled) {
            result += this.generateToC();
            result += '\n';
        }

        return result + this.content + '\n' + this.footer;
    }
}
