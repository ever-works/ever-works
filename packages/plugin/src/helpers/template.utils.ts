/**
 * Extract variable names from a template string type.
 * e.g., ExtractVariableNames<"Hello {name}, you are {age}"> = "name" | "age"
 */
export type ExtractVariableNames<T extends string> = T extends `${string}{${infer Var}}${infer Rest}`
	? Var | ExtractVariableNames<Rest>
	: never;

/**
 * Typed variables record for a template.
 * - Literal template → Record<extracted_names, string> (enforced)
 * - Plain `string` → Record<string, string> (loose, backward-compat)
 */
export type TemplateVariables<T extends string> =
	ExtractVariableNames<T> extends never
		? Record<string, string> | undefined
		: Record<ExtractVariableNames<T>, string>;

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
export function substituteVariables<T extends string>(template: T, variables?: TemplateVariables<T>): string {
	if (!variables) return template;
	return template.replace(/\{(\w+)\}/g, (match, key) => {
		const value = (variables as Record<string, string>)[key];
		return value !== undefined ? value : match;
	});
}
