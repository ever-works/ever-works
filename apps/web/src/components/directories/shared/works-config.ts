export function formatWorksConfigProviders(
    providers?: Record<string, unknown> | object | null,
    separator = ': ',
): string | null {
    if (!providers || Object.keys(providers).length === 0) {
        return null;
    }

    const providerEntries = Object.entries(providers)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([capability, provider]) => `${capability}${separator}${provider}`);

    return providerEntries.length > 0 ? providerEntries.join(', ') : null;
}
