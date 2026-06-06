import { Injectable, Inject } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import { ApiClientService } from '../../api-client/api-client.service.js';
import { toMcpError } from '../../api-client/api-error.js';
import { resolveKbDocId } from './resolve-doc-id.js';

/**
 * EW-643 Phase 3 slice 3 — `kb.unlock` MCP tool.
 *
 * Mirrors `POST /api/works/:id/kb/documents/:docId/unlock`. Symmetric
 * to `kb.lock` — returns the document with `locked=false` and emits the
 * unlock activity-log event added in slice 1.
 */
const KbUnlockSchema = z.object({
	workId: z.string().uuid().describe('Work UUID.'),
	idOrPath: z.string().min(1).describe('Document UUID or KB path.')
});

@Injectable()
export class KbUnlockTool {
	constructor(@Inject(ApiClientService) private readonly apiClient: ApiClientService) {}

	@Tool({
		name: 'kb.unlock',
		description: 'Unlock a previously-locked Knowledge Base document so agents may edit it again.',
		parameters: KbUnlockSchema
	})
	async unlock(input: z.infer<typeof KbUnlockSchema>) {
		try {
			const docId = await resolveKbDocId(this.apiClient, input.workId, input.idOrPath);
			const path = `/works/${encodeURIComponent(input.workId)}/kb/documents/${encodeURIComponent(docId)}/unlock`;
			const result = await this.apiClient.request('POST', path);

			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
			};
		} catch (err) {
			return toMcpError(err);
		}
	}
}
