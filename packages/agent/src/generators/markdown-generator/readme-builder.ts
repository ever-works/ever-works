import { slugifyText } from '../../utils/text.utils';
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
            toc += '## 📑 Table of Contents\n\n';
            this.toc.forEach(({ header, count }) => {
                const slug = slugifyText(header);
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
