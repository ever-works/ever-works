import { Injectable, Inject } from '@nestjs/common';
import { McpConfigService } from '../config/mcp-config.service.js';
import { ApiError } from './api-error.js';
import { sanitizeResponse } from './sanitize.js';

@Injectable()
export class ApiClientService {
	constructor(@Inject(McpConfigService) private readonly config: McpConfigService) {}

	async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const url = `${this.config.apiUrl}${path}`;

		const init: RequestInit = {
			method,
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': this.config.apiKey
			},
			signal: AbortSignal.timeout(30_000)
		};

		if (body !== undefined) {
			init.body = JSON.stringify(body);
		}

		const response = await fetch(url, init);

		let data: unknown;
		const contentType = response.headers.get('content-type');
		if (contentType?.includes('application/json')) {
			data = await response.json();
		} else {
			data = await response.text();
		}

		if (!response.ok) {
			const message =
				data && typeof data === 'object' && 'message' in data
					? String((data as Record<string, unknown>).message)
					: `HTTP ${response.status} ${response.statusText}`;
			throw new ApiError(response.status, message, data);
		}

		return sanitizeResponse(data as T);
	}
}
