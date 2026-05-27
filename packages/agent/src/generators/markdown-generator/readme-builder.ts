import GithubSlugger from 'github-slugger';
import type { ItemData } from '@ever-works/plugin';

// Module-scoped slugger — shared by ALL ReadmeBuilder instances in this
// process. `GithubSlugger` is stateful: repeated `slug('Tools')` calls
// return `tools`, `tools-1`, `tools-2`, ... so the same header label
// in two different builders ends up with mismatched anchors (the
// markdown header stays `## Tools`, but the TOC link points at
// `#tools-1`).
//
// If you start generating multiple READMEs per process, instantiate
// the slugger inside `build()` (or per-instance in the constructor),
// and bump test coverage to lock that in — moving it here is a
// behaviour change to anchor IDs across runs.
const slugger = new GithubSlugger();

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

    addItem(item: ItemData, options: { hasDetails?: boolean } = {}) {
        // TODO: consider making featured items bolder (item.featured)
        this.content += `- [${item.name}](${item.source_url}) - ${item.description}`;
        if (options.hasDetails) {
            this.content += ` ([Read more](/details/${item.slug}.md))`;
        }

        if (item.tags && item.tags.length > 0) {
            const tags = item.tags.map((tag) => `\`${tag.name}\``).join(' ');
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
