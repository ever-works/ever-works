// APW-09 T43 — the store is driven through the real module graph below, so the
// one sibling module `UpstreamPullRequestsModule` imports for `GitFacadeService`
// is shelled exactly as `app-works.module.spec.ts` and
// `app-upstream-state.service.spec.ts` shell it. `DatabaseModule` and
// `AppWorksModule` are deliberately NOT shelled: the whole point of the second
// half of this spec is that the real repositories (and the real row they write)
// carry the binding, and that APW-02's repository reaches this epic's store
// across the module boundary. A handover never calls the git facade — the
// service makes no provider call at all (FR-43) — so an empty shell is a
// supported graph for it, and it was the only module shelled until 2026-09-26.
jest.mock('../../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));
// Since 2026-09-26 `AppWorksModule` also imports `TasksDomainModule` (the conflict
// Task its upstream state service files). That module's agents graph needs the real
// facades — `WorkflowAiDecisionAdapter` takes `AiFacadeService` non-optionally — so
// with `FacadesModule` shelled it is shelled too. A handover files no Task, so an
// empty shell is a supported graph for it; `ActivityLogModule` and
// `NotificationsModule` stay real, over the real `DatabaseModule`.
jest.mock('../../tasks-domain/tasks.module', () => ({
    TasksDomainModule: class TasksDomainModule {},
}));

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { WorkUpstreamStateRepository } from '../../database/repositories/work-upstream-state.repository';
import { AuthAccount } from '../../entities/auth-account.entity';
import { WorkMember } from '../../entities/work-member.entity';
import { WorkUpstreamState } from '../../entities/work-upstream-state.entity';
import { Work } from '../../entities/work.entity';
import { WorkMemberRole } from '../../entities/types';
import { UpstreamPullRequestsModule } from '../upstream-pull-requests.module';
import {
    UPSTREAM_CREDENTIAL_STORE,
    UpstreamCredentialService,
} from '../upstream-credential.service';
import {
    UpstreamCredentialRecordUnwrittenError,
    UpstreamCredentialStateStore,
} from '../upstream-credential.store';

/**
 * APW-09 T43 — the durable credential of record, and the binding that makes the
 * real graph carry one (FR-43, XC-18, ACC-09-32).
 *
 * The column and its migration are asserted where they live
 * (`work-upstream-state.entity.spec.ts`,
 * `apps/api/.../AddWorkUpstreamCredentialMember.spec.ts`); this spec is about the
 * two things that make the record real rather than notional:
 *
 *   1. **`write` then `read` answer each other, through the row.** With a store
 *      that never persisted, or one that answered another Work's member, a
 *      handover would look successful and the next background job would resolve
 *      the old member — the defect XC-18 names.
 *   2. **The bound store is the one the service gets.** The second half boots
 *      `UpstreamPullRequestsModule` in a real Nest container over the real
 *      `DatabaseModule` (in-memory better-sqlite3, `synchronize`), performs a
 *      handover through `UpstreamCredentialService` **resolved from that
 *      container**, and reads the **durable row** back from the DataSource — not
 *      from the store's return value, and not from a hand fake. `AppWorksModule`
 *      (which owns the row this writes) is imported by the epic's module, not
 *      shelled, so the token really does cross the module boundary.
 *
 * ## Why the handover needs no git facade here
 *
 * `handover` resolves edit access, the caller's connection and the record, and
 * writes; it never resolves a token and never touches a provider (the service's
 * own docstring, and `upstream-credential.service.spec.ts`'s throwing provider
 * spies). So the shelled `FacadesModule` changes nothing about what is proven
 * here, while `AuthAccountRepository` — the read that decides whether the
 * caller's connection is usable — is the real one, against a real `account` row.
 *
 * Every uuid and login below is obviously synthetic.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORK_ID = '22222222-2222-4222-8222-222222222222';
const CREATOR_ID = '33333333-3333-4333-8333-333333333333';
const EDITOR_ID = '44444444-4444-4444-8444-444444444444';
const STRANGER_ID = '55555555-5555-4555-8555-555555555555';

describe('UpstreamCredentialStateStore — the durable record', () => {
    let dataSource: DataSource;
    let states: WorkUpstreamStateRepository;
    let store: UpstreamCredentialStateStore;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        // The owning Work row is not what is under test here — the row the store
        // writes is — and `works.userId` carries a real FK to `users.id`. Same
        // baseline as `work-upstream-state.repository.spec.ts`.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        states = new WorkUpstreamStateRepository(dataSource.getRepository(WorkUpstreamState));
        store = new UpstreamCredentialStateStore(states);
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(WorkUpstreamState).clear();
    });

    /** A state row, with the coordinates and readiness defaults plan §3.1 gives one. */
    function seedState(
        workId = WORK_ID,
        overrides: Partial<WorkUpstreamState> = {},
    ): Promise<WorkUpstreamState> {
        const rows = dataSource.getRepository(WorkUpstreamState);
        return rows.save(
            rows.create({
                workId,
                relation: 'fork',
                dataOwner: 'ever-works',
                dataRepo: 'cloc',
                dataDefaultBranch: 'main',
                upstreamOwner: 'cloc-co',
                upstreamRepo: 'cloc',
                upstreamDefaultBranch: 'main',
                readinessStartedAt: new Date(),
                ...overrides,
            }),
        );
    }

    /** The stored member, read straight from the table rather than the row object. */
    async function storedMember(workId: string): Promise<string | null> {
        const row = await dataSource
            .getRepository(WorkUpstreamState)
            .findOneOrFail({ where: { workId } });

        return row.credentialMemberUserId ?? null;
    }

    it('answers null for a Work that has no state row at all', async () => {
        await expect(store.read(WORK_ID)).resolves.toBeNull();
    });

    it('answers null for a state row nobody has handed over on', async () => {
        await seedState();

        await expect(store.read(WORK_ID)).resolves.toBeNull();
    });

    it('round-trips: what write records is what read answers', async () => {
        await seedState();

        await store.write(WORK_ID, EDITOR_ID);

        await expect(store.read(WORK_ID)).resolves.toBe(EDITOR_ID);
        // The row itself changed — the store holds no copy of its own.
        await expect(storedMember(WORK_ID)).resolves.toBe(EDITOR_ID);
    });

    it('moves the record on a second handover, and leaves the first member nothing to read', async () => {
        await seedState();

        await store.write(WORK_ID, CREATOR_ID);
        await store.write(WORK_ID, EDITOR_ID);

        await expect(store.read(WORK_ID)).resolves.toBe(EDITOR_ID);
        await expect(storedMember(WORK_ID)).resolves.toBe(EDITOR_ID);
    });

    it('refuses by name when there is no row to record the handover on — and writes nothing', async () => {
        // APW-01 creates the state row with the Work, so this is an anomaly; the
        // one thing it must not do is answer as if the handover had happened.
        await expect(store.write(WORK_ID, EDITOR_ID)).rejects.toBeInstanceOf(
            UpstreamCredentialRecordUnwrittenError,
        );
        await expect(store.write(WORK_ID, EDITOR_ID)).rejects.toMatchObject({
            code: 'handover_unavailable',
            workId: WORK_ID,
            memberUserId: EDITOR_ID,
        });

        // No row was invented for it either: the credential write is an UPDATE.
        await expect(dataSource.getRepository(WorkUpstreamState).count()).resolves.toBe(0);
    });

    it('scopes the write to the one Work named, and reaches no other Work', async () => {
        await seedState(WORK_ID);
        await seedState(OTHER_WORK_ID, { credentialMemberUserId: CREATOR_ID });

        await store.write(WORK_ID, EDITOR_ID);

        await expect(storedMember(WORK_ID)).resolves.toBe(EDITOR_ID);
        // The other App Work keeps the member it had.
        await expect(storedMember(OTHER_WORK_ID)).resolves.toBe(CREATOR_ID);
    });
});

describe('UpstreamCredentialStateStore — the binding in the real graph', () => {
    let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
    let dataSource: DataSource;
    let service: UpstreamCredentialService;

    beforeAll(async () => {
        // The real `DatabaseModule`, reached through the epic's own module —
        // nothing is stubbed for it: `NODE_ENV=test` gives it an in-memory
        // better-sqlite3 DataSource and `synchronize`, so the row a handover
        // writes is a row of the schema the app boots with.
        moduleRef = await Test.createTestingModule({
            imports: [UpstreamPullRequestsModule],
        }).compile();
        dataSource = moduleRef.get(DataSource);
        // The owning User rows are not what is under test — the Work, its state
        // row and the member's connection are — and `works.userId` /
        // `work_members.userId` carry real FKs to `users.id`. Same baseline as
        // `work-upstream-state.repository.spec.ts`.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        service = moduleRef.get(UpstreamCredentialService);
    }, 120_000);

    afterAll(async () => {
        await moduleRef?.close();
    });

    beforeEach(async () => {
        await dataSource.getRepository(WorkMember).clear();
        await dataSource.getRepository(WorkUpstreamState).clear();
        await dataSource.getRepository(AuthAccount).clear();
        await dataSource.getRepository(Work).clear();
    });

    /** The App Work, owned by {@link CREATOR_ID}. */
    async function seedWork(id = WORK_ID, userId = CREATOR_ID) {
        const works = dataSource.getRepository(Work);
        return works.save(
            works.create({
                id,
                name: 'Cloc',
                slug: `cloc-${id.slice(-4)}`,
                description: 'An app Work',
                userId,
                kind: 'app',
            } as Partial<Work>),
        );
    }

    async function seedState(workId = WORK_ID) {
        const rows = dataSource.getRepository(WorkUpstreamState);
        return rows.save(
            rows.create({
                workId,
                relation: 'fork',
                dataOwner: 'ever-works',
                dataRepo: 'cloc',
                dataDefaultBranch: 'main',
                upstreamOwner: 'cloc-co',
                upstreamRepo: 'cloc',
                upstreamDefaultBranch: 'main',
                readinessState: 'ready',
                readinessStartedAt: new Date(),
            }),
        );
    }

    /** A connected GitHub account with the `repo` scope a push and a PR need. */
    async function seedConnection(userId: string) {
        const accounts = dataSource.getRepository(AuthAccount);
        return accounts.save(
            accounts.create({
                id: `account-${userId}`,
                userId,
                accountId: `github-${userId}`,
                providerId: 'plugin:github',
                accessToken: `token-${userId}`,
                scope: 'repo',
                username: `login-${userId.slice(-4)}`,
                metadata: { login: `login-${userId.slice(-4)}` },
            }),
        );
    }

    async function seedMembership(workId: string, userId: string, role: WorkMemberRole) {
        const members = dataSource.getRepository(WorkMember);
        return members.save(members.create({ workId, userId, role }));
    }

    /** The stored member, read from the DataSource rather than from the store. */
    async function storedMember(workId: string): Promise<string | null> {
        const row = await dataSource
            .getRepository(WorkUpstreamState)
            .findOneOrFail({ where: { workId } });

        return row.credentialMemberUserId ?? null;
    }

    it('binds the store token to the store, and the service receives it', async () => {
        const bound = moduleRef.get<UpstreamCredentialStateStore>(UPSTREAM_CREDENTIAL_STORE);

        expect(bound).toBeInstanceOf(UpstreamCredentialStateStore);

        // The service's own view of it: checking only the token would pass while
        // the service still injected `undefined` and refused every handover with
        // `handover_unavailable`.
        expect((service as unknown as { store?: unknown }).store).toBe(bound);
    });

    it('provides and exports the store, the service and the token', () => {
        const metadata = (key: string): unknown[] =>
            (Reflect.getMetadata(key, UpstreamPullRequestsModule) as unknown[]) ?? [];

        expect(metadata('providers')).toContain(UpstreamCredentialStateStore);
        expect(metadata('providers')).toContain(UpstreamCredentialService);
        // The binding itself, not just a provider of the same name.
        expect(metadata('providers')).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    provide: UPSTREAM_CREDENTIAL_STORE,
                    useExisting: UpstreamCredentialStateStore,
                }),
            ]),
        );
        for (const exported of [
            UpstreamCredentialStateStore,
            UpstreamCredentialService,
            UPSTREAM_CREDENTIAL_STORE,
        ]) {
            expect(metadata('exports')).toContain(exported);
        }
    });

    it('records a handover on the durable row, and the next read answers the new member', async () => {
        await seedWork();
        await seedState();
        await seedConnection(EDITOR_ID);
        await seedMembership(WORK_ID, EDITOR_ID, WorkMemberRole.EDITOR);

        const result = await service.handover(WORK_ID, EDITOR_ID);

        expect(result).toEqual({
            ok: true,
            workId: WORK_ID,
            memberUserId: EDITOR_ID,
            previousMemberUserId: CREATOR_ID,
            source: 'handover',
        });
        // The DURABLE row — not the store's answer, and not a fake's memory.
        await expect(storedMember(WORK_ID)).resolves.toBe(EDITOR_ID);

        // And the record the background jobs read now names the editor.
        await expect(service.credentialOfRecord(WORK_ID)).resolves.toEqual({
            workId: WORK_ID,
            memberUserId: EDITOR_ID,
            source: 'handover',
            providerId: 'github',
        });
    });

    it('never reports a handover the store could not record', async () => {
        // An App Work with no upstream state row: APW-01 writes both together, so
        // this is an anomaly — and the one outcome that must not happen is a
        // success. The real store refuses, and the refusal reaches the caller
        // rather than being reported as a done handover.
        await seedWork();
        await seedConnection(CREATOR_ID);

        await expect(service.handover(WORK_ID, CREATOR_ID)).rejects.toBeInstanceOf(
            UpstreamCredentialRecordUnwrittenError,
        );

        await expect(dataSource.getRepository(WorkUpstreamState).count()).resolves.toBe(0);
    });

    it('leaves the row NULL until a handover happens — the creator is derived, not stored twice', async () => {
        await seedWork();
        await seedState();
        await seedConnection(CREATOR_ID);

        await expect(service.credentialOfRecord(WORK_ID)).resolves.toMatchObject({
            memberUserId: CREATOR_ID,
            source: 'creator',
        });
        // Reading the record never writes one.
        await expect(storedMember(WORK_ID)).resolves.toBeNull();
    });

    it('refuses a caller who is not on this App Work, and records nothing — another organization’s member cannot take it over', async () => {
        // The stranger owns (or edits) a DIFFERENT App Work, which is the shape
        // "another organization's member" takes at this layer: the rule the
        // repository and the service enforce is the Work's own edit access
        // (`WorkRepository` + `WorkMemberRepository`, the visibility layer), not
        // an organization predicate on the state row — `tenantId` /
        // `organizationId` are carried stamps there, never predicates.
        await seedWork();
        await seedState();
        const otherWork = await seedWork(OTHER_WORK_ID, STRANGER_ID);
        await seedState(OTHER_WORK_ID);
        await seedConnection(STRANGER_ID);
        await seedMembership(OTHER_WORK_ID, STRANGER_ID, WorkMemberRole.OWNER);
        expect(otherWork.userId).toBe(STRANGER_ID);

        await expect(service.handover(WORK_ID, STRANGER_ID)).resolves.toEqual({
            ok: false,
            workId: WORK_ID,
            refusal: 'not_edit_access',
        });

        // Neither row moved: not the App Work the stranger asked for, and not
        // the one they legitimately own.
        await expect(storedMember(WORK_ID)).resolves.toBeNull();
        await expect(storedMember(OTHER_WORK_ID)).resolves.toBeNull();
    });

    it('refuses a member without edit access, and records nothing', async () => {
        await seedWork();
        await seedState();
        await seedConnection(EDITOR_ID);
        await seedMembership(WORK_ID, EDITOR_ID, WorkMemberRole.VIEWER);

        await expect(service.handover(WORK_ID, EDITOR_ID)).resolves.toEqual({
            ok: false,
            workId: WORK_ID,
            refusal: 'not_edit_access',
        });
        await expect(storedMember(WORK_ID)).resolves.toBeNull();
    });

    it('refuses when the caller’s own connection cannot be used, and records nothing', async () => {
        await seedWork();
        await seedState();
        await seedConnection(EDITOR_ID);
        await seedMembership(WORK_ID, EDITOR_ID, WorkMemberRole.EDITOR);
        // The connection is withdrawn: connected rows are gone.
        await dataSource.getRepository(AuthAccount).clear();

        await expect(service.handover(WORK_ID, EDITOR_ID)).resolves.toEqual({
            ok: false,
            workId: WORK_ID,
            refusal: 'credential_unusable',
            reason: 'disconnected',
        });
        await expect(storedMember(WORK_ID)).resolves.toBeNull();
    });
});
