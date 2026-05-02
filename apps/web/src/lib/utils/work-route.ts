const DIRECTORIES_SEGMENT = 'works';
const NON_WORK_DETAIL_SEGMENTS = new Set(['new']);

const getPathSegments = (pathname: string): string[] => pathname.split('/').filter(Boolean);

export function getWorkIdFromPath(pathname: string): string | null {
    const segments = getPathSegments(pathname);

    if (segments[0] !== DIRECTORIES_SEGMENT || segments.length < 2) {
        return null;
    }

    const workId = segments[1];

    if (!workId || NON_WORK_DETAIL_SEGMENTS.has(workId)) {
        return null;
    }

    return workId;
}

export function isWorkDetailPath(pathname: string): boolean {
    return getWorkIdFromPath(pathname) !== null;
}

export function replaceWorkIdInPath(pathname: string, nextWorkId: string): string | null {
    const trimmedWorkId = nextWorkId.trim();
    if (!trimmedWorkId) {
        return null;
    }

    const segments = getPathSegments(pathname);

    if (!getWorkIdFromPath(pathname)) {
        return null;
    }

    segments[1] = trimmedWorkId;

    return `/${segments.join('/')}`;
}
