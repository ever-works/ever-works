import { APP_BUILD_DEPLOYABLE_TRIGGERS } from '@ever-works/contracts';

import {
    AppDeployBuildSourceAdapter,
    DEPLOYABLE_PAGE_SIZE,
    imageReferenceOf,
} from '../app-deploy-build.source';
import type { AppBuildRepository } from '../../database/repositories/app-build.repository';

/**
 * APW-06 §5.1 — `APP_DEPLOY_BUILD_SOURCE` over APW-05's Build rows.
 *
 * Two reads with opposite jobs, which is what every case below is about:
 *
 *   - `listDeployableBuilds` OFFERS Builds, so it filters hard — the trigger
 *     list AND APW-05's own `deployable` verdict;
 *   - `getBuild` ANSWERS about the Build the caller named, so it filters not at
 *     all. §5.1 has its own `build_not_applicable` refusal and it has to be able
 *     to see the Build to give it.
 *
 * Plus the composed image reference, where "unconfirmed digest" and "no image"
 * have to be the same answer: a tag can move, a digest cannot, and a Deployment
 * that runs a reference nobody verified is running an image its Build may never
 * have produced.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`;

function build(overrides: Record<string, unknown> = {}) {
    return {
        id: 'b-1',
        commitSha: 'c'.repeat(40),
        status: 'succeeded',
        trigger: 'push',
        imageRepository: 'ghcr.io/acme/app',
        imageDigest: DIGEST,
        digestConfirmed: true,
        deployable: true,
        ...overrides,
    };
}

type RepoMock = { findByIdForWork: jest.Mock; findPage: jest.Mock };

function repo(rows: Record<string, unknown>[] = [], one: unknown = null): RepoMock {
    return {
        findByIdForWork: jest.fn(async () => one),
        findPage: jest.fn(async () => ({
            rows,
            total: rows.length,
            page: 1,
            pageSize: DEPLOYABLE_PAGE_SIZE,
            hasMore: false,
        })),
    };
}

function source(mock: RepoMock): AppDeployBuildSourceAdapter {
    return new AppDeployBuildSourceAdapter(mock as unknown as AppBuildRepository);
}

describe('listDeployableBuilds', () => {
    it('asks the query for green Builds with a DEPLOYABLE trigger', async () => {
        const mock = repo([build()]);

        await source(mock).listDeployableBuilds('w-1');

        expect(mock.findPage).toHaveBeenCalledWith(
            'w-1',
            { status: ['succeeded'], trigger: [...APP_BUILD_DEPLOYABLE_TRIGGERS] },
            1,
            DEPLOYABLE_PAGE_SIZE,
        );
        // The list itself, pinned: a `pull_request` Build succeeded at some
        // commit, and running it would be a preview, not a Deployment.
        expect([...APP_BUILD_DEPLOYABLE_TRIGGERS]).toEqual(['push', 'manual']);
    });

    it('also applies APW-05’s own `deployable` verdict', async () => {
        // The trigger says which KINDS may deploy; the verdict folds in what a
        // trigger cannot see — a confirmed digest, the secret check. Asking only
        // one of them offers a Build that cannot actually run.
        const mock = repo([build({ id: 'ok' }), build({ id: 'no-verdict', deployable: false })]);

        const list = await source(mock).listDeployableBuilds('w-1');

        expect(list?.map((row) => row.id)).toEqual(['ok']);
    });

    it('treats a missing verdict as NOT deployable', async () => {
        const mock = repo([build({ id: 'undecided', deployable: undefined })]);

        expect(await source(mock).listDeployableBuilds('w-1')).toEqual([]);
    });

    it('bounds the read — an App Work with a thousand Builds costs the same as one with five', async () => {
        await source(repo()).listDeployableBuilds('w-1');

        expect(DEPLOYABLE_PAGE_SIZE).toBe(20);
    });

    it('answers [] for none and null for "could not read"', async () => {
        // The port's own distinction: §5.1 reports "no green Build" for the
        // first and "I could not tell" for the second, and they are different
        // things to show an owner.
        expect(await source(repo()).listDeployableBuilds('w-1')).toEqual([]);
        expect(
            await new AppDeployBuildSourceAdapter(undefined).listDeployableBuilds('w-1'),
        ).toBeNull();
    });
});

describe('getBuild', () => {
    it('answers the Build the caller named, whatever its trigger or verdict', async () => {
        // A source that hid it would turn "you cannot deploy a PR build" into
        // "that build does not exist".
        const mock = repo([], build({ trigger: 'pull_request', deployable: false }));

        const snapshot = await source(mock).getBuild('w-1', 'b-1');

        expect(snapshot?.trigger).toBe('pull_request');
    });

    it('narrows to the five fields §5.1 reads', async () => {
        const mock = repo([], build({ billableMinutes: 12, verificationPlan: { checks: [] } }));

        expect(await source(mock).getBuild('w-1', 'b-1')).toEqual({
            id: 'b-1',
            commitSha: 'c'.repeat(40),
            status: 'succeeded',
            trigger: 'push',
            imageReference: `ghcr.io/acme/app@${DIGEST}`,
        });
    });

    it('answers null for a Build that is not this Work’s, and for no repository', async () => {
        expect(await source(repo()).getBuild('w-1', 'nope')).toBeNull();
        expect(await new AppDeployBuildSourceAdapter(undefined).getBuild('w-1', 'b-1')).toBeNull();
    });
});

describe('imageReferenceOf', () => {
    it('composes the DIGEST-pinned reference', () => {
        expect(
            imageReferenceOf({
                imageRepository: 'ghcr.io/acme/app',
                imageDigest: DIGEST,
                digestConfirmed: true,
            }),
        ).toBe(`ghcr.io/acme/app@${DIGEST}`);
    });

    it('answers null for an UNCONFIRMED digest', () => {
        // The entity says it at the column: "only a confirmed digest is ever
        // deployable". §5.1 reports this as `build_image_missing`, which is the
        // honest answer — we have a string, and nobody checked it is real.
        expect(
            imageReferenceOf({
                imageRepository: 'ghcr.io/acme/app',
                imageDigest: DIGEST,
                digestConfirmed: false,
            }),
        ).toBeNull();
    });

    it('answers null when either half is missing', () => {
        expect(imageReferenceOf({ imageDigest: DIGEST, digestConfirmed: true })).toBeNull();
        expect(
            imageReferenceOf({ imageRepository: 'ghcr.io/acme/app', digestConfirmed: true }),
        ).toBeNull();
        expect(imageReferenceOf({})).toBeNull();
    });
});
