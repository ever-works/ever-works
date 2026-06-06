import { Injectable, Inject } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import { ApiClientService } from '../../api-client/api-client.service.js';
import { toMcpError } from '../../api-client/api-error.js';
import { KB_LOCK_MODES } from '@ever-works/contracts';
import { resolveKbDocId } from './resolve-doc-id.js';

/**
 * EW-643 Phase 3 slice 3 — `kb.lock` MCP tool.
 *
 * Mirrors `POST /api/works/:id/kb/documents/:docId/lock`. The lock
 * controller emits the activity-log event recorded in slice 1 (Phase 3
 * row 28). `lockMode` is either:
 *   - "full":           reject all agent edits.
 *   - "additions-only": agents may append, not modify existing body.
 */
const KbLockSchema = z.object({
	workId: z.string().uuid().describe('Work UUID.'),
	idOrPath: z.string().min(1).describe('Document UUID or KB path.'),
	lockMode: z
		.enum(KB_LOCK_MODES)
		.describe('Lock granularity. "full" blocks all agent edits; "additions-only" permits appends.')
});

@Injectable()
export class KbLockTool {
	constructor(@Inject(ApiClientService) private readonly apiClient: ApiClientService) {}

	@Tool({
		name: 'kb.lock',
		description:
			'Lock a Knowledge Base document so subsequent agent edits are rejected (full) ' +
			'or restricted to additions-only. Returns the updated KbDocumentDto with locked=true.',
		parameters: KbLockSchema
	})
	async lock(input: z.infer<typeof KbLockSchema>) {
		try {
			const docId = await resolveKbDocId(this.apiClient, input.workId, input.idOrPath);
			const path = `/works/${encodeURIComponent(input.workId)}/kb/documents/${encodeURIComponent(docId)}/lock`;
			// Controller expects `{ mode }` on the body — match LockKbDocumentDto.
			const result = await this.apiClient.request('POST', path, { mode: input.lockMode });

			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
			};
		} catch (err) {
			return toMcpError(err);
		}
	}
}
