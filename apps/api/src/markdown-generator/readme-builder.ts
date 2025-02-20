import slugify from "slugify";
import { ItemData } from "../ai-engine/ai-engine.service";

export class ReadmeBuilder {
    private top: string = '';
    private content: string = '';
    private isTocEnabled: boolean = false;
    private readonly toc: string[] = []; // Table of Contents

    constructor(private readonly markdowns: Set<string>) { }

    setTitle(title: string) {
        this.top += `# ${title}\n\n`;
        return this;
    }

    setDescription(description: string) {
        this.top += `${description}\n\n`;
        return this;
    }

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

    addItem(item: ItemData) {
        this.content += `- [${item.name}](${item.source_url}) - ${item.description}`;
        if (item.slug && this.markdowns.has(item.slug)) {
            this.content += ` ([Read more](/details/${item.slug}.md))`;
        }
        this.content += '\n';
        return this;
    }

    build(): string {
        let result = this.top + '\n';
        
        if (this.isTocEnabled) {
            result += this.generateToC();
            result += '\n';
        }

        return result + this.content;
    }
}
