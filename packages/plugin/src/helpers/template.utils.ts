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
 * Security: this is a raw, structure-agnostic string substitution — values are
 * inserted verbatim with NO XML/markdown escaping or delimiting. When a template
 * is an LLM prompt and a value originates from an untrusted source (user work
 * name/description, the request prompt, fetched web pages, or repo file
 * contents), the CALLER must fence that value before passing it in — wrap it in a
 * named untrusted-data block (e.g. `<work_context untrusted="true">…`,
 * `<user_instruction untrusted="true">…`, `<page_content untrusted="true">…`) with
 * a data-only preamble, exactly as the agent-pipeline prompt builders do. Do not
 * rely on this function to neutralize embedded prompt-injection text; it cannot
 * tell trusted template fragments from untrusted values.
 *
 * @param template - Template string with `{variable}` placeholders
 * @param variables - Key-value pairs to substitute (untrusted values must be
 *   pre-fenced/escaped by the caller when the result is an LLM prompt)
 * @returns The template with matched placeholders replaced
 */
export function substituteVariables<T extends string>(template: T, variables?: TemplateVariables<T>): string {
	if (!variables) return template;
	return template.replace(/\{(\w+)\}/g, (match, key) => {
		const value = (variables as Record<string, string>)[key];
		return value !== undefined ? value : match;
	});
}
