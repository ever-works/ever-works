const DIRECTORIES_SEGMENT = 'directories';
const NON_DIRECTORY_DETAIL_SEGMENTS = new Set(['new']);

const getPathSegments = (pathname: string): string[] => pathname.split('/').filter(Boolean);

export function getDirectoryIdFromPath(pathname: string): string | null {
    const segments = getPathSegments(pathname);

    if (segments[0] !== DIRECTORIES_SEGMENT || segments.length < 2) {
        return null;
    }

    const directoryId = segments[1];

    if (!directoryId || NON_DIRECTORY_DETAIL_SEGMENTS.has(directoryId)) {
        return null;
    }

    return directoryId;
}

export function isDirectoryDetailPath(pathname: string): boolean {
    return getDirectoryIdFromPath(pathname) !== null;
}

export function replaceDirectoryIdInPath(pathname: string, nextDirectoryId: string): string | null {
    const trimmedDirectoryId = nextDirectoryId.trim();
    if (!trimmedDirectoryId) {
        return null;
    }

    const segments = getPathSegments(pathname);

    if (!getDirectoryIdFromPath(pathname)) {
        return null;
    }

    segments[1] = trimmedDirectoryId;

    return `/${segments.join('/')}`;
}
