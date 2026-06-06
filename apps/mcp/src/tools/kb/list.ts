import { Injectable, Inject } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import { ApiClientService } from '../../api-client/api-client.service.js';
import { toMcpError } from '../../api-client/api-error.js';
import { KB_DOCUMENT_CLASSES, KB_DOCUMENT_STATUSES } from '@ever-works/contracts';

/**
 * EW-643 Phase 3 slice 3 — `kb.list` MCP tool.
 *
 * Mirrors `GET /api/works/:id/kb/documents`. The upstream controller is
 * `apps/api/src/works/kb.controller.ts#listDocuments`; query shape is
 * the contracts-package `KbDocumentListFilter` (a subset of which is
 * exposed here — class / status / tag / q / limit / offset).
 *
 * Auth follows the standard `ApiClientService` flow (per-user JWT
 * forwarded if present, falls back to shared key in hybrid mode).
 */
const KbListSchema = z.object({
	workId: z.string().uuid().describe('Work UUID. The KB document list is scoped to this Work.'),
	class: z
		.enum(KB_DOCUMENT_CLASSES)
		.optional()
		.describe('Filter by document class (e.g. "brand", "legal", "seo").'),
	status: z.enum(KB_DOCUMENT_STATUSES).optional().describe('Filter by lifecycle status.'),
	tag: z.string().optional().describe('Filter to documents tagged with this tag slug.'),
	q: z.string().optional().describe('Lexical search across title/description/body.'),
	limit: z.number().int().min(1).max(100).optional().describe('Max documents to return (1-100).'),
	offset: z.number().int().min(0).optional().describe('Pagination offset.')
});

@Injectable()
export class KbListTool {
	constructor(@Inject(ApiClientService) private readonly apiClient: ApiClientService) {}

	@Tool({
		name: 'kb.list',
		description:
			'List Knowledge Base documents for a Work. Returns { items, total }. ' +
			'Supports filtering by class / status / tag, lexical search via q, and limit/offset paging.',
		parameters: KbListSchema,
		annotations: { readOnlyHint: true }
	})
	async list(input: z.infer<typeof KbListSchema>) {
		try {
			const qs = new URLSearchParams();
			if (input.class) qs.append('class', input.class);
			if (input.status) qs.append('status', input.status);
			if (input.tag) qs.append('tag', input.tag);
			if (input.q) qs.append('q', input.q);
			if (input.limit !== undefined) qs.append('limit', String(input.limit));
			if (input.offset !== undefined) qs.append('offset', String(input.offset));

			const query = qs.toString();
			const path = `/works/${encodeURIComponent(input.workId)}/kb/documents${query ? `?${query}` : ''}`;
			const result = await this.apiClient.request('GET', path);

			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
			};
		} catch (err) {
			return toMcpError(err);
		}
	}
}
