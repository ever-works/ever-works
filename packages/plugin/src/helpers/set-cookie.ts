export function splitSetCookieHeader(headerValue: string): string[] {
	const cookies: string[] = [];
	let current = '';
	let inExpiresAttribute = false;

	for (let i = 0; i < headerValue.length; i++) {
		const char = headerValue[i];
		const nextPart = headerValue.slice(i).toLowerCase();

		if (!inExpiresAttribute && nextPart.startsWith('expires=')) {
			inExpiresAttribute = true;
		}

		if (char === ',') {
			if (inExpiresAttribute) {
				current += char;
				continue;
			}

			if (current.trim()) {
				cookies.push(current.trim());
			}
			current = '';
			continue;
		}

		if (inExpiresAttribute && char === ';') {
			inExpiresAttribute = false;
		}

		current += char;
	}

	if (current.trim()) {
		cookies.push(current.trim());
	}

	return cookies;
}
