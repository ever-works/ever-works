import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

export interface ContentChunk {
	text: string;
	index: number;
	total: number;
}

export interface ChunkResult {
	chunks: ContentChunk[];
	wasSplit: boolean;
}

export async function chunkContent(content: string, maxChunkChars: number): Promise<ChunkResult> {
	if (content.length <= maxChunkChars) {
		return { chunks: [{ text: content, index: 0, total: 1 }], wasSplit: false };
	}

	const splitter = new RecursiveCharacterTextSplitter({
		separators: ['\n## ', '\n### ', '\n#### ', '\n\n', '\n', '. ', ' ', ''],
		chunkSize: maxChunkChars,
		chunkOverlap: Math.floor(maxChunkChars * 0.15)
	});

	const docs = await splitter.createDocuments([content]);
	const total = docs.length;

	return {
		chunks: docs.map((doc, index) => ({ text: doc.pageContent, index, total })),
		wasSplit: true
	};
}
