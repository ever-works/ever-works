export function buildPublicComparisonUrl(websiteUrl: string, comparisonSlug: string): string {
    // Security: reject non-HTTP(S) schemes (e.g. javascript:, data:) to prevent stored XSS
    // when a deployment plugin writes a malicious URL into work.website.
    if (!websiteUrl.startsWith('https://') && !websiteUrl.startsWith('http://')) {
        return '#';
    }
    return `${websiteUrl.replace(/\/+$/, '')}/comparisons/${comparisonSlug}`;
}

export function formatComparisonDate(value: string): string {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return value;

    const [, year, month, day] = match;
    return `${Number(month)}/${Number(day)}/${year}`;
}
