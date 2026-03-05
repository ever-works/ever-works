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
			const details = JSON.stringify(error.body, null, 2);
			text += `\n${details}`;
		}
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
