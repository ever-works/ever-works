export function inferFrameworkFromRepository(repo: string): string | null {
    const normalized = repo.toLowerCase();
    if (normalized.includes('astro')) return 'Astro';
    if (normalized.includes('next')) return 'Next.js';
    return null;
}
