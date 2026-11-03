/**
 * Jest stub for the ESM-only `github-slugger`, used by the DI-compile lane
 * (`jest.di.config.js`) only.
 *
 * See `apps/api/test/jest-mocks/README.md` for why substituting a leaf npm
 * utility cannot mask the defect this lane exists to catch.
 */
export default class GithubSlugger {
    private readonly occurrences = new Map<string, number>();

    slug(value: string): string {
        const base = String(value)
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9 -]/g, '')
            .replace(/\s+/g, '-');
        const seen = this.occurrences.get(base) ?? 0;
        this.occurrences.set(base, seen + 1);
        return seen === 0 ? base : `${base}-${seen}`;
    }

    reset(): void {
        this.occurrences.clear();
    }
}
