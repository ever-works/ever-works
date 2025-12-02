import { Injectable } from '@nestjs/common';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

/**
 * Semantic-aware chunker: splits by semantic separators first (headers/paragraphs),
 * then falls back to recursive character splitting for oversized sections.
 */
@Injectable()
export class SemanticChunker {
    private readonly splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 3000,
        chunkOverlap: 200,
        separators: ['\n## ', '\n### ', '\n\n', '\n- ', '. '],
    });

    async chunkContent(content: string): Promise<string[]> {
        if (!content) return [];

        // Prefer splitting by headings/paragraphs to preserve context
        const sections = this.extractSections(content);
        const chunks: string[] = [];

        for (const section of sections) {
            if (section.length <= 3000) {
                chunks.push(section);
            } else {
                const subChunks = await this.splitter.splitText(section);
                chunks.push(...subChunks);
            }
        }

        return chunks;
    }

    private extractSections(content: string): string[] {
        // Split by H2/H3 style headers first; fallback to paragraphs.
        const headerSplit = content.split(/\n(?=##\s)/).filter(Boolean);
        if (headerSplit.length > 1) {
            return headerSplit.map((c) => c.trim());
        }
        const paragraphSplit = content.split(/\n\s*\n/).filter(Boolean);
        return paragraphSplit.length > 1 ? paragraphSplit.map((c) => c.trim()) : [content.trim()];
    }
}
