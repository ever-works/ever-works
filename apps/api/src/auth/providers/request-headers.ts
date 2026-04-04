export function toHeaders(
	input: Record<string, string | string[] | undefined> | Headers | undefined
): Headers {
	if (input instanceof Headers) {
		return new Headers(input);
	}

	const headers = new Headers();
	for (const [key, value] of Object.entries(input || {})) {
		if (!value) {
			continue;
		}

		headers.set(key, Array.isArray(value) ? value.join(', ') : value);
	}

	return headers;
}
