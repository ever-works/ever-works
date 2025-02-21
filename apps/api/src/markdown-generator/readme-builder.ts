import slugify from "slugify";
import { ItemData, Tag } from "../ai-engine/ai-engine.service";

export class ReadmeBuilder {
    private content: string = '';
    private isTocEnabled: boolean = false;
    private readonly toc: string[] = []; // Table of Contents

    constructor(
        private readonly header: string,
        private readonly footer: string,
    ) {}

    addHeader(header: string) {
        this.content += `# ${header}\n\n`;
        return this;
    }

    addSubHeader(header: string) {
        this.content += `## ${header}\n\n`;
        this.toc.push(header);
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
            toc += '## Table of Contents\n\n';
            this.toc.forEach((header) => {
                const slug = slugify(header, { lower: true, trim: true });
                toc += `- [${header}](#${slug})\n`;
            });
            toc += '\n';
        }

        return toc;
    }

    addItem(item: ItemData, options: { hasDetails?: boolean } = {}) {
        this.content += `- [${item.name}](${item.source_url}) - ${item.description}`;
        if (options.hasDetails) {
            this.content += ` ([Read more](/details/${item.slug}.md))`;
        }

        if (item.tags && item.tags.length > 0) {
            const tags = item.tags.map(tag => `\`${tag.name}\``).join(' ');
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
