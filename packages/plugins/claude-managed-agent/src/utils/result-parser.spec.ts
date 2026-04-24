import { describe, expect, it } from 'vitest';

import { extractAgentTranscript, normalizeOutputs, parseStructuredOutput } from './result-parser.js';

describe('result-parser', () => {
	it('extracts only agent message text blocks from events', () => {
		const transcript = extractAgentTranscript([
			{
				id: '1',
				type: 'user.message',
				content: [{ type: 'text', text: 'ignore me' }]
			},
			{
				id: '2',
				type: 'agent.message',
				content: [{ type: 'text', text: 'first block' }, { type: 'image' }]
			},
			{
				id: '3',
				type: 'agent.message',
				content: [{ type: 'text', text: 'second block' }]
			}
		]);

		expect(transcript).toBe('first block\n\nsecond block');
	});

	it('parses fenced JSON output and normalizes items and operations', () => {
		const structured = parseStructuredOutput(`Here is the final result:

\`\`\`json
{
  "items": [
    {
      "name": "Example Item",
      "description": "A short description",
      "source_url": "https://example.com",
      "category": ["Tools"],
      "tags": ["alpha"],
      "collection": "Examples",
      "brand": "Example Inc",
      "brand_logo_url": "https://example.com/logo.png",
      "images": ["https://example.com/image.png"],
      "featured": true
    }
  ],
  "operations": {
    "created_files": ["example-item.json"],
    "updated_files": [],
    "unchanged_seeded_files_count": 2
  },
  "warnings": ["done"]
}
\`\`\``);

		const normalized = normalizeOutputs(structured);

		expect(normalized.items).toHaveLength(1);
		expect(normalized.items[0]?.name).toBe('Example Item');
		expect(normalized.items[0]?.category).toEqual(['Tools']);
		expect(normalized.collections.map((entry) => entry.name)).toContain('Examples');
		expect(normalized.brands.map((entry) => entry.name)).toContain('Example Inc');
		expect(normalized.extra?.operations).toEqual({
			created_files: ['example-item.json'],
			updated_files: [],
			unchanged_seeded_files_count: 2
		});
	});
});
