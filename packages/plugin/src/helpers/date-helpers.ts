/**
 * Returns the current date formatted for use in LLM prompts.
 * Example: "Monday, February 2026"
 */
export function getCurrentDateString(): string {
	const fmt = new Intl.DateTimeFormat('en-US', {
		weekday: 'long',
		month: 'long',
		year: 'numeric'
	});
	const parts = fmt.formatToParts(new Date());
	const weekday = parts.find((p) => p.type === 'weekday')?.value;
	const month = parts.find((p) => p.type === 'month')?.value;
	const year = parts.find((p) => p.type === 'year')?.value;
	return `${weekday}, ${month} ${year}`;
}
