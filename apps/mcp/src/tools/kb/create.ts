import { Injectable, Inject } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import { ApiClientService } from '../../api-client/api-client.service.js';
import { toMcpError } from '../../api-client/api-error.js';
import { KB_DOCUMENT_CLASSES, KB_DOCUMENT_STATUSES } from '@ever-works/contracts';

/**
 * EW-643 Phase 3 slice 3 — `kb.create` MCP tool.
 *
 * Mirrors `POST /api/works/:id/kb/documents`. Input shape matches
 * `CreateKbDocumentInput` from `@ever-works/contracts/kb`.
 */
const KbCreateSchema = z.object({
	workId: z.string().uuid().describe('Work UUID under which the document will live.'),
	path: z
		.string()
		.min(1)
		.max(512)
		.describe('KB path / slug (slash-separated, e.g. "brand/voice"). Must be unique per Work.'),
	title: z.string().min(1).max(256).describe('Human-readable title for the document.'),
	body: z.string().describe('Markdown body. May be empty for stub documents.'),
	class: z
		.enum(KB_DOCUMENT_CLASSES)
		.describe('Document class (e.g. "brand", "legal", "seo"). Drives downstream routing.'),
	description: z.string().nullable().optional().describe('Short summary shown in lists.'),
	tags: z.array(z.string()).optional().describe('Tag slugs to attach.'),
	categories: z.array(z.string()).optional().describe('Category slugs to attach.'),
	language: z.string().optional().describe('BCP-47 language code (default "en").'),
	status: z.enum(KB_DOCUMENT_STATUSES).optional().describe('Lifecycle status (default "active").')
});

@Injectable()
export class KbCreateTool {
	constructor(@Inject(ApiClientService) private readonly apiClient: ApiClientService) {}

	@Tool({
		name: 'kb.create',
		description:
			'Create a new Knowledge Base document for a Work. Returns the created KbDocumentDto. ' +
			'Use kb.update to amend the body later, or kb.lock once the content is final.',
		parameters: KbCreateSchema
	})
	async create(input: z.infer<typeof KbCreateSchema>) {
		try {
			const { workId, ...body } = input;
			const path = `/works/${encodeURIComponent(workId)}/kb/documents`;
			const result = await this.apiClient.request('POST', path, body);

			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
			};
		} catch (err) {
			return toMcpError(err);
		}
	}
}
