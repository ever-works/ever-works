import { ApiError } from './errors.js';

export class EverWorksClient {
	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string
	) {}

	private get headers(): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			'x-api-key': this.apiKey
		};
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const url = `${this.baseUrl}${path}`;

		const init: RequestInit = {
			method,
			headers: this.headers
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

		return data as T;
	}

	async get<T>(path: string): Promise<T> {
		return this.request<T>('GET', path);
	}

	async post<T>(path: string, body?: unknown): Promise<T> {
		return this.request<T>('POST', path, body);
	}

	async put<T>(path: string, body?: unknown): Promise<T> {
		return this.request<T>('PUT', path, body);
	}

	async patch<T>(path: string, body?: unknown): Promise<T> {
		return this.request<T>('PATCH', path, body);
	}

	async delete<T>(path: string): Promise<T> {
		return this.request<T>('DELETE', path);
	}
}
