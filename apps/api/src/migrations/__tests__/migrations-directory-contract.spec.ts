import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Deployed history: changing any of these filenames or timestamps can make
 * TypeORM treat an old migration as new. Keep the debt visible and frozen;
 * only genuinely new collisions should fail the contract below.
 */
const LEGACY_DUPLICATE_TIMESTAMPS: Record<string, string[]> = {
    '1779800000000': [
        '1779800000000-AddMagicLinkToken.ts',
        '1779800000000-AddWorkProposalGeneratedPrompt.ts',
    ],
    '1781600000000': [
        '1781600000000-CreateIdeaWorksTable.ts',
        '1781600000000-CreateTeamResources.ts',
    ],
    '1781700000000': [
        '1781700000000-CreateAgentActionProposals.ts',
        '1781700000000-CreateMissionWorksTable.ts',
    ],
    '1781800000000': [
        '1781800000000-AddAgentScorecard.ts',
        '1781800000000-AddMissionOutcomeToMissions.ts',
    ],
    '1781900000000': [
        '1781900000000-AddAgentGuardrailsAndProposalDecidedVia.ts',
        '1781900000000-AddOrganizationVision.ts',
    ],
    '1782000000000': [
        '1782000000000-AddKbDocumentConsolidation.ts',
        '1782000000000-RenameWorkAgentGoalsToWorkBuildRequests.ts',
    ],
    '1782100000000': [
        '1782100000000-CreateGoalsTables.ts',
        '1782100000000-CreateInboundTriggers.ts',
    ],
    '1782300000000': [
        '1782300000000-AddTaskOwnerScopeColumns.ts',
        '1782300000000-AddWorkDeployDatabaseMode.ts',
    ],
    '1784200000000': [
        '1784200000000-AddWorkExternalRefs.ts',
        '1784200000000-CreateFleetJobs.ts',
        '1784200000000-CreateIngestInstallBindings.ts',
    ],
    '1784300000000': [
        '1784300000000-AddTaskPrStatusColumns.ts',
        '1784300000000-CreateBillingProfilesAndInvoices.ts',
        '1784300000000-CreateKbRetrievalLogsAndMemoryCadence.ts',
        '1784300000000-CreateTerminalTranscriptChunks.ts',
    ],
    '1786950000000': [
        '1786950000000-AddCreditLedgerBuckets.ts',
        '1786950000000-AddUserUploadScopeIndex.ts',
    ],
};

/**
 * `apps/api/src/migrations/` is not an ordinary source directory — it is
 * the input to a RUNTIME glob.
 *
 * `packages/agent/src/database/database.config.ts` boots the API with
 * `migrations: ['<cwd>/dist/migrations/*.js', '<cwd>/apps/api/dist/migrations/*.js']`
 * and `migrationsRun: true` (prod/stage). The glob is FLAT and matches
 * every `.js` file in that one directory, while `nest build -b swc`
 * compiles the whole of `src` — spec files included — into `dist`.
 *
 * So any file dropped directly into `src/migrations/` is executed by
 * `DataSource.initialize()` on every pod boot. For a Jest spec that
 * means its top-level `describe(...)` runs outside Jest and throws
 * `ReferenceError: describe is not defined`, TypeORM's
 * `DirectoryExportedClassesLoader` propagates it, and the API
 * crash-loops — invisibly, because Kubernetes rolls back to the old
 * pods. That is the incident this file exists to prevent; migration
 * specs therefore live one level down in `__tests__/`, whose compiled
 * output (`dist/migrations/__tests__/*.js`) the glob cannot reach.
 */
describe('src/migrations directory contract', () => {
    const MIGRATIONS_DIR = join(__dirname, '..');

    /** Only files the runtime glob would actually pick up. */
    const flatFiles = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);

    it('contains no test file that the runtime migration glob would execute', () => {
        const specs = flatFiles.filter((name) => /\.(spec|test)\.ts$/.test(name));

        expect(specs).toEqual([]);
    });

    it('every flat file is a timestamped migration module, nothing else', () => {
        const strays = flatFiles.filter((name) => !/^\d{13}-[A-Za-z0-9]+\.ts$/.test(name));

        expect(strays).toEqual([]);
    });

    it('introduces no timestamp collision beyond the exact frozen deployed history', () => {
        const filesByTimestamp = new Map<string, string[]>();
        for (const name of flatFiles) {
            const timestamp = name.slice(0, 13);
            filesByTimestamp.set(timestamp, [...(filesByTimestamp.get(timestamp) ?? []), name]);
        }

        const duplicates = Object.fromEntries(
            [...filesByTimestamp.entries()]
                .filter(([, names]) => names.length > 1)
                .map(([timestamp, names]) => [timestamp, names.sort()]),
        );

        expect(duplicates).toEqual(LEGACY_DUPLICATE_TIMESTAMPS);
    });

    it('no flat migration file references Jest globals', () => {
        // Belt and braces: a helper that merely IMPORTS a spec would be
        // just as fatal, and the filename check above cannot see that.
        const offenders = flatFiles.filter((name) => {
            const source = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
            return /^\s*(describe|it|test)\s*\(/m.test(source);
        });

        expect(offenders).toEqual([]);
    });
});
