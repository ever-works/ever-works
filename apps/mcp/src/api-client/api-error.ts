import { sanitizeResponse } from './sanitize.js';
import { fenceUntrustedToolResult } from './fence-untrusted.js';

export class ApiError extends Error {
	constructor(
		public readonly statusCode: number,
		message: string,
		public readonly body?: unknown
	) {
		super(message);
		this.name = 'ApiError';
	}
}

export function toMcpError(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
	let text: string;

	if (error instanceof ApiError) {
		text = `API Error (${error.statusCode}): ${error.message}`;
		if (error.body && typeof error.body === 'object') {
			// Security: strip sensitive fields (apiKey, token, secret, ...) from the
			// upstream error body before it is surfaced verbatim into the MCP tool
			// result / LLM context. The success path already runs response bodies
			// through sanitizeResponse in ApiClientService; error bodies bypassed it,
			// so credentials echoed in a 4xx/5xx payload could leak to the model.
			const details = JSON.stringify(sanitizeResponse(error.body), null, 2);
			// Security: like the success path in tool-registration.service, fence the
			// (already secret-stripped) upstream error body as UNTRUSTED data. Error
			// bodies can echo hostile ingested content (work/item names, README text),
			// so a prompt-injection payload in a 4xx/5xx detail must reach the client's
			// LLM labelled as data, not as instructions it might follow.
			text += `\n${fenceUntrustedToolResult(details)}`;
		}
	} else if (error instanceof Error && error.name === 'TimeoutError') {
		text = 'Request timed out after 30 seconds. The API server may be slow or unreachable.';
	} else if (error instanceof Error) {
		text = error.message;
	} else {
		text = String(error);
	}

	return {
		content: [{ type: 'text', text }],
		isError: true
	};
}
