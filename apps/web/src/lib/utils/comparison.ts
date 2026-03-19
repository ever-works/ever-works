export function buildPublicComparisonUrl(websiteUrl: string, comparisonSlug: string): string {
    return `${websiteUrl.replace(/\/+$/, '')}/comparisons/${comparisonSlug}`;
}

export function formatComparisonDate(value: string): string {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return value;

    const [, year, month, day] = match;
    return `${Number(month)}/${Number(day)}/${year}`;
}
