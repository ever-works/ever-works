import { Injectable, Inject } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import { ApiClientService } from '../../api-client/api-client.service.js';
import { toMcpError } from '../../api-client/api-error.js';
import { KB_DOCUMENT_STATUSES } from '@ever-works/contracts';
import { resolveKbDocId } from './resolve-doc-id.js';

/**
 * EW-643 Phase 3 slice 3 — `kb.update` MCP tool.
 *
 * Mirrors `PATCH /api/works/:id/kb/documents/:docId`. Input matches
 * `UpdateKbDocumentInput` from `@ever-works/contracts/kb`, wrapped in
 * a `patch` envelope so the tool call stays explicit about which fields
 * are intended to change vs left alone.
 *
 * The REST endpoint requires a UUID `docId`; when the caller passes a
 * KB path we resolve it via the get endpoint first (see `resolve-doc-id`).
 */
const KbUpdatePatchSchema = z
	.object({
		title: z.string().min(1).max(256).optional(),
		description: z.string().nullable().optional(),
		body: z.string().optional(),
		tags: z.array(z.string()).optional(),
		categories: z.array(z.string()).optional(),
		language: z.string().optional(),
		status: z.enum(KB_DOCUMENT_STATUSES).optional()
	})
	.refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

const KbUpdateSchema = z.object({
	workId: z.string().uuid().describe('Work UUID.'),
	idOrPath: z.string().min(1).describe('Document UUID or KB path.'),
	patch: KbUpdatePatchSchema.describe('Partial update — only the supplied fields are changed.')
});

@Injectable()
export class KbUpdateTool {
	constructor(@Inject(ApiClientService) private readonly apiClient: ApiClientService) {}

	@Tool({
		name: 'kb.update',
		description:
			'Apply a partial update to a Knowledge Base document. Returns the updated KbDocumentDto. ' +
			'Use kb.lock first if you want subsequent agent edits to be rejected.',
		parameters: KbUpdateSchema
	})
	async update(input: z.infer<typeof KbUpdateSchema>) {
		try {
			const docId = await resolveKbDocId(this.apiClient, input.workId, input.idOrPath);
			const path = `/works/${encodeURIComponent(input.workId)}/kb/documents/${encodeURIComponent(docId)}`;
			const result = await this.apiClient.request('PATCH', path, input.patch);

			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
			};
		} catch (err) {
			return toMcpError(err);
		}
	}
}
