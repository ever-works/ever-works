import { Injectable, Inject } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import { ApiClientService } from '../../api-client/api-client.service.js';
import { toMcpError } from '../../api-client/api-error.js';

/**
 * EW-643 Phase 3 slice 3 — `kb.get` MCP tool.
 *
 * Mirrors `GET /api/works/:id/kb/documents/:docIdOrPath`. The controller
 * resolves `docIdOrPath` as a UUID first, then as a path (slash-separated
 * KB path). Returns `KbDocumentBodyDto` (metadata + Markdown body + asset
 * summaries).
 */
const KbGetSchema = z.object({
	workId: z.string().uuid().describe('Work UUID.'),
	idOrPath: z
		.string()
		.min(1)
		.describe('Either the document UUID or its KB path (e.g. "brand/voice").')
});

@Injectable()
export class KbGetTool {
	constructor(@Inject(ApiClientService) private readonly apiClient: ApiClientService) {}

	@Tool({
		name: 'kb.get',
		description:
			'Fetch a single Knowledge Base document by id or by KB path. ' +
			'Returns the full body, metadata, and linked asset summaries.',
		parameters: KbGetSchema,
		annotations: { readOnlyHint: true }
	})
	async get(input: z.infer<typeof KbGetSchema>) {
		try {
			const path = `/works/${encodeURIComponent(input.workId)}/kb/documents/${encodeURIComponent(input.idOrPath)}`;
			const result = await this.apiClient.request('GET', path);

			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
			};
		} catch (err) {
			return toMcpError(err);
		}
	}
}
