export function slugifyText(text: string): string {
    return text
        .toString()
        .normalize('NFKD') // Normalize accented characters
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^\w-]+/g, '')
        .replace(/--+/g, '-');
}

export function unSlugifyText(slug: string): string {
    return slug
        .replace(/-/g, ' ')
        .replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
}
