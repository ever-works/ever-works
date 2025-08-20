export function generateHexToken(length = 16) {
    const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .substring(0, length);
}
