import type { ApiClientService } from '../../api-client/api-client.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * EW-643 Phase 3 slice 3 — shared helper for `kb.update` / `kb.lock` /
 * `kb.unlock`.
 *
 * The mutating REST endpoints take a `:docId` UUID parameter (validated
 * with `ParseUUIDPipe`), while `GET .../:docIdOrPath` happily resolves
 * either a UUID or a KB path. The MCP tools accept `idOrPath` for parity
 * with `kb.get`, so when the caller supplies a path we first resolve it
 * to a UUID via the get endpoint and then issue the mutating call.
 */
export async function resolveKbDocId(apiClient: ApiClientService, workId: string, idOrPath: string): Promise<string> {
	if (UUID_RE.test(idOrPath)) {
		return idOrPath;
	}
	const path = `/works/${encodeURIComponent(workId)}/kb/documents/${encodeURIComponent(idOrPath)}`;
	const doc = await apiClient.request<{ id: string }>('GET', path);
	return doc.id;
}
