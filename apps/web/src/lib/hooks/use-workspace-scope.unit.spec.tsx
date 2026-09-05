// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const pathnameMock = vi.fn<() => string>();
vi.mock('next/navigation', () => ({
    usePathname: () => pathnameMock(),
}));

import { useWorkspaceScope } from './use-workspace-scope';

describe('useWorkspaceScope', () => {
    it('reads the Organization from the visible tab path', () => {
        pathnameMock.mockReturnValue('/org/ever/memory');

        expect(renderHook(() => useWorkspaceScope()).result.current).toEqual({
            kind: 'organization',
            slug: 'ever',
        });
    });

    it('is personal on an unprefixed path', () => {
        pathnameMock.mockReturnValue('/dashboard');

        expect(renderHook(() => useWorkspaceScope()).result.current).toEqual({ kind: 'personal' });
    });

    it('is null on a malformed /org path instead of throwing in render', () => {
        pathnameMock.mockReturnValue('/org/Not_Valid/memory');

        expect(renderHook(() => useWorkspaceScope()).result.current).toBeNull();
    });
});
