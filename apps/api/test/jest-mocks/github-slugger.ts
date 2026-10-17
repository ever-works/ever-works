/**
 * Jest replacement for the ESM-only `github-slugger` package (see the
 * `moduleNameMapper` rule in `apps/api/jest.config.js`).
 *
 * Mirrors the behaviour readme-builder relies on: lower-case, drop
 * characters that are not letters, digits, spaces or dashes, spaces to `-`,
 * and, like the real package, `-1`, `-2`, … advanced until the slug is unused
 * within one instance (`Tools`, `Tools-1`, `Tools` -> `tools`, `tools-1`,
 * `tools-2`), so two headings never share an anchor.
 */
export function slug(value: string): string {
    return String(value)
        .toLowerCase()
        .trim()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s/g, '-');
}

export default class GithubSlugger {
    private occurrences: Record<string, number> = {};

    slug(value: string): string {
        const original = slug(value);
        let result = original;
        while (Object.prototype.hasOwnProperty.call(this.occurrences, result)) {
            this.occurrences[original] += 1;
            result = `${original}-${this.occurrences[original]}`;
        }
        this.occurrences[result] = 0;
        return result;
    }

    reset(): void {
        this.occurrences = {};
    }
}
