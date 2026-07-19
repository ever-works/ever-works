// Known Ever Works base template repos → their web framework. Explicit map so
// names that don't contain "next"/"astro" (e.g. `web-template`, the directory
// templates) still resolve correctly. Falls back to substring heuristics for
// custom/unknown repos.
const KNOWN_FRAMEWORKS: Record<string, string> = {
    'directory-web-template': 'Next.js',
    'directory-web-minimal-template': 'Astro',
    'web-template': 'Next.js',
    'web-minimal-template': 'Astro',
};

export function inferFrameworkFromRepository(repo: string): string | null {
    const normalized = repo.toLowerCase();
    if (KNOWN_FRAMEWORKS[normalized]) return KNOWN_FRAMEWORKS[normalized];
    if (normalized.includes('astro')) return 'Astro';
    if (normalized.includes('minimal')) return 'Astro';
    if (normalized.includes('next')) return 'Next.js';
    if (normalized.includes('web')) return 'Next.js';
    return null;
}
