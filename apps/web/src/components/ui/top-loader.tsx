'use client';

import NextTopLoader from 'nextjs-toploader';

export function TopLoader() {
    return (
        <NextTopLoader color="#3b82f6" height={2} showSpinner={false} easing="ease" speed={100} />
    );
}
