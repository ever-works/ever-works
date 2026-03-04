/**
 * Substitute `{variable}` placeholders in a template string.
 *
 * Unmatched placeholders are left as-is so templates remain safe even
 * when a variable is intentionally omitted.
 *
 * @param template - Template string with `{variable}` placeholders
 * @param variables - Key-value pairs to substitute
 * @returns The template with matched placeholders replaced
 */
export function substituteVariables(template: string, variables?: Record<string, string>): string {
	if (!variables) return template;
	return template.replace(/\{(\w+)\}/g, (match, key) => {
		const value = variables[key];
		return value !== undefined ? value : match;
	});
}
