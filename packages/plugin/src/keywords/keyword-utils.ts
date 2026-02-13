import * as stopword from 'stopword';

export interface ExtractKeywordsOptions {
	maxKeywords?: number;
	minWordLength?: number;
}

const DEFAULT_MAX_KEYWORDS = 20;
const DEFAULT_MIN_WORD_LENGTH = 2;

const ALL_STOPWORDS: string[] = Object.values(stopword)
	.filter((v): v is string[] => Array.isArray(v))
	.flat();

export function extractKeywords(text: string, options?: ExtractKeywordsOptions): string[] {
	if (!text) return [];

	const maxKeywords = options?.maxKeywords ?? DEFAULT_MAX_KEYWORDS;
	const minLen = options?.minWordLength ?? DEFAULT_MIN_WORD_LENGTH;

	const words = tokenize(text);
	const filtered = stopword.removeStopwords(words, ALL_STOPWORDS).filter((w) => w.length > minLen);

	return [...new Set(filtered)].slice(0, maxKeywords);
}

export function extractKeywordsFromPrompt(prompt?: string, subject?: string, maxKeywords = 15): string[] {
	const keywords: string[] = [];

	if (subject) {
		keywords.push(subject.toLowerCase());
	}

	if (prompt) {
		keywords.push(...extractKeywords(prompt, { maxKeywords }));
	}

	return [...new Set(keywords)].slice(0, maxKeywords);
}

function tokenize(text: string): string[] {
	if (typeof Intl !== 'undefined' && Intl.Segmenter) {
		const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
		return [...segmenter.segment(text)].filter((s) => s.isWordLike).map((s) => s.segment.toLowerCase());
	}

	// Fallback: regex-based tokenization
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.split(/\s+/)
		.filter(Boolean);
}
