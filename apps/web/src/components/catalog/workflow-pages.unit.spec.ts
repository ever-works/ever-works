import { describe, expect, it } from 'vitest';
import {
    WORKFLOW_LIST_PAGE_SIZE,
    catalogHref,
    catalogPageWindow,
    firstSearchParam,
    isCatalogUuid,
    parseCatalogOffset,
    runForWorkflow,
} from './workflow-pages';

const WORKFLOW_A = '11111111-1111-4111-8111-111111111111';
const WORKFLOW_B = '22222222-2222-4222-8222-222222222222';

describe('parseCatalogOffset', () => {
    it.each<[string | string[] | undefined, number]>([
        [undefined, 0],
        ['', 0],
        ['50', 50],
        [['100', '50'], 100],
        ['-50', 0],
        ['2.5', 0],
        ['abc', 0],
        ['1e3', 0],
        ['99999999999999999999', 0],
    ])('reads %j as %d', (raw, expected) => {
        expect(parseCatalogOffset(raw)).toBe(expected);
    });
});

describe('catalogPageWindow', () => {
    it('offers Next when a full first page does not reach the total', () => {
        expect(
            catalogPageWindow({
                offset: 0,
                pageSize: WORKFLOW_LIST_PAGE_SIZE,
                itemCount: 50,
                total: 51,
            }),
        ).toEqual({ from: 1, to: 50, total: 51, previousOffset: null, nextOffset: 50 });
    });

    it('reaches the last item on the next page and offers Previous back', () => {
        expect(catalogPageWindow({ offset: 50, pageSize: 50, itemCount: 1, total: 51 })).toEqual({
            from: 51,
            to: 51,
            total: 51,
            previousOffset: 0,
            nextOffset: null,
        });
    });

    it('offers neither link when everything fits on one page', () => {
        const page = catalogPageWindow({ offset: 0, pageSize: 50, itemCount: 3, total: 3 });
        expect(page.previousOffset).toBeNull();
        expect(page.nextOffset).toBeNull();
    });

    it('sends an offset past the end back to the last real page', () => {
        expect(catalogPageWindow({ offset: 500, pageSize: 50, itemCount: 0, total: 51 })).toEqual({
            from: 0,
            to: 0,
            total: 51,
            previousOffset: 50,
            nextOffset: null,
        });
        expect(
            catalogPageWindow({ offset: 100, pageSize: 50, itemCount: 0, total: 0 }).previousOffset,
        ).toBe(0);
    });

    it('never produces a negative Previous for an offset that is not a page boundary', () => {
        expect(
            catalogPageWindow({ offset: 10, pageSize: 50, itemCount: 41, total: 51 })
                .previousOffset,
        ).toBe(0);
    });

    it('continues from what was actually returned when the server sends a shorter page', () => {
        expect(
            catalogPageWindow({ offset: 0, pageSize: 50, itemCount: 20, total: 51 }).nextOffset,
        ).toBe(20);
    });
});

describe('catalogHref', () => {
    it('omits empty values and zero offsets so the first page is the bare path', () => {
        expect(catalogHref('/catalog/workflows', { offset: 0 })).toBe('/catalog/workflows');
        expect(catalogHref('/catalog/workflows', { offset: 50 })).toBe(
            '/catalog/workflows?offset=50',
        );
        expect(
            catalogHref(`/catalog/workflows/${WORKFLOW_A}`, {
                runsOffset: 50,
                run: WORKFLOW_B,
                other: null,
            }),
        ).toBe(`/catalog/workflows/${WORKFLOW_A}?runsOffset=50&run=${WORKFLOW_B}`);
    });
});

describe('runForWorkflow', () => {
    it('renders a run that belongs to the workflow on the page', () => {
        const run = { id: 'run-1', workflowId: WORKFLOW_A };
        expect(runForWorkflow(run, WORKFLOW_A)).toBe(run);
    });

    it("refuses another workflow's run, even one the same person owns", () => {
        expect(runForWorkflow({ id: 'run-b', workflowId: WORKFLOW_B }, WORKFLOW_A)).toBeNull();
    });

    it('reads a missing run as nothing to render', () => {
        expect(runForWorkflow(null, WORKFLOW_A)).toBeNull();
        expect(runForWorkflow(undefined, WORKFLOW_A)).toBeNull();
    });
});

describe('search param helpers', () => {
    it('takes the first of a repeated param and accepts only canonical UUIDs', () => {
        expect(firstSearchParam(['a', 'b'])).toBe('a');
        expect(firstSearchParam('a')).toBe('a');
        expect(isCatalogUuid(WORKFLOW_A)).toBe(true);
        expect(isCatalogUuid('not-a-uuid')).toBe(false);
        expect(isCatalogUuid(undefined)).toBe(false);
    });
});
