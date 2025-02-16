import { ItemData } from "../ai-engine/ai-engine.service";

export class ReadmeBuilder {
    private content: string = '';

    constructor(private readonly markdowns: Set<string>) {}

    addHeader(header: string) {
        this.content += `# ${header}\n\n`;
        return this;
    }

    addSubHeader(header: string) {
        this.content += `## ${header}\n\n`;
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

    addTableOfContents(table: Array<{ name?: string; slug: string }>) {
        table.forEach((item) => {
            this.content += `- [${item.name || item.slug}](#${item.slug})\n`;
        });
        this.content += '\n';

        return this
    }

    addItem(item: ItemData) {
        this.content += `- [${item.name}](${item.source_url}) - ${item.description}`;
        if (item.slug && this.markdowns.has(`${item.slug}.md`)) {
            this.content += ` ([Read more](/details/${item.slug}.md))`;
        }
        this.content += '\n';
        return this;
    }

    build() {
        return this.content;
    }
}
