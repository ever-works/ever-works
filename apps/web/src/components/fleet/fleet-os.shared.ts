/**
 * Fleet hub (FL-01) — the operating system a computer reports, as one of the
 * words the hub shows (`fleet.os.<key>`). A node reports `platform` as
 * `<os>/<arch>` (`linux/x64`, `darwin/arm64`, `win32/x64`); anything else is
 * shown as reported, and nothing is shown as "Unknown OS".
 */
export type FleetOsKey = 'linux' | 'darwin' | 'win32' | 'other' | 'unknown';

export function osKeyOf(platform: string | null | undefined): FleetOsKey {
    if (!platform) return 'unknown';
    const os = platform.split('/')[0]?.trim().toLowerCase();
    if (os === 'linux' || os === 'darwin' || os === 'win32') return os;
    return 'other';
}
