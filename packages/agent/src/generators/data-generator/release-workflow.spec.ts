import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import {
    DATA_REPO_RELEASE_WORKFLOW,
    DATA_REPO_RELEASE_WORKFLOW_MARKER,
    DATA_REPO_RELEASE_WORKFLOW_PATH,
    DATA_REPO_RELEASE_WORKFLOW_VERSION,
    isManagedReleaseWorkflow,
    parseReleaseWorkflowVersion,
} from './release-workflow';

const ASSET_PATH = path.join(__dirname, 'assets', 'data-repo-release.yml');

describe('data repository release workflow (EW-58)', () => {
    describe('the embedded copy', () => {
        it('is byte-identical to assets/data-repo-release.yml', () => {
            // The YAML file is the human-editable source; the constant is a
            // generated copy so the data generator can write it without
            // relying on asset copying. `node
            // scripts/generate-data-repo-release-workflow.mjs` re-syncs them.
            const asset = fs.readFileSync(ASSET_PATH, 'utf-8').replace(/\r\n/g, '\n');
            expect(DATA_REPO_RELEASE_WORKFLOW).toBe(asset);
        });

        it('is installed at the conventional workflow path', () => {
            expect(DATA_REPO_RELEASE_WORKFLOW_PATH).toBe('.github/workflows/release.yml');
        });
    });

    describe('the workflow itself', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let workflow: any;

        beforeAll(() => {
            workflow = yaml.parse(DATA_REPO_RELEASE_WORKFLOW);
        });

        it('parses as YAML and declares a single release job', () => {
            expect(workflow.name).toBe('Release data');
            expect(Object.keys(workflow.jobs)).toEqual(['release']);
            expect(workflow.jobs.release['runs-on']).toBe('ubuntu-latest');
        });

        it('requests only contents: write', () => {
            expect(workflow.permissions).toEqual({ contents: 'write' });
        });

        it('runs on data pushes to the default branch and on demand', () => {
            // `on` is a YAML 1.1 boolean, which the `yaml` package resolves to
            // the key `true`. GitHub's own parser keeps it as the string 'on'.
            const triggers = workflow.on ?? workflow['true'] ?? workflow[String(true)];

            expect(triggers.push.branches).toEqual(['main', 'master']);
            expect(triggers.push.paths).toEqual(
                expect.arrayContaining([
                    'data/**',
                    'markdown/**',
                    'pages/**',
                    'categories.yml',
                    'collections.yml',
                    'tags.yml',
                    'references.yml',
                ]),
            );
            // A settings-only works.yml edit must not cut a release.
            expect(triggers.push.paths).not.toContain('.works/works.yml');
            expect(triggers).toHaveProperty('workflow_dispatch');
        });

        it('serializes releases per ref without cancelling a half-finished one', () => {
            expect(workflow.concurrency['cancel-in-progress']).toBe(false);
        });

        it('checks out the full history so existing tags are visible', () => {
            const checkout = workflow.jobs.release.steps.find((step: { uses?: string }) =>
                step.uses?.startsWith('actions/checkout@'),
            );

            expect(checkout).toBeDefined();
            expect(checkout.with['fetch-depth']).toBe(0);
        });

        it('creates the tag and the release only when a version was resolved', () => {
            const release = workflow.jobs.release.steps.find((step: { uses?: string }) =>
                step.uses?.startsWith('ncipollo/release-action@'),
            );

            expect(release).toBeDefined();
            expect(release.if).toBe("steps.resolve.outputs.release == 'true'");
            expect(release.with.tag).toBe('${{ steps.resolve.outputs.tag }}');
            expect(release.with.generateReleaseNotes).toBe(true);
            expect(release.with.skipIfReleaseExists).toBe(true);
        });

        it('keeps the version rollover rules the data generator uses', () => {
            const resolve = workflow.jobs.release.steps.find(
                (step: { id?: string }) => step.id === 'resolve',
            );

            expect(resolve.run).toContain('-ge 100');
            expect(resolve.run).toContain('-ge 10');
            expect(resolve.run).toContain('.works/works.yml');
        });

        it('passes the manual version through the environment, never inline', () => {
            const resolve = workflow.jobs.release.steps.find(
                (step: { id?: string }) => step.id === 'resolve',
            );

            expect(resolve.env.REQUESTED_VERSION).toBe('${{ inputs.version }}');
            expect(resolve.run).not.toContain('${{');
        });
    });

    describe('the managed-file marker', () => {
        it('recognises the shipped workflow as managed at the shipped version', () => {
            expect(isManagedReleaseWorkflow(DATA_REPO_RELEASE_WORKFLOW)).toBe(true);
            expect(parseReleaseWorkflowVersion(DATA_REPO_RELEASE_WORKFLOW)).toBe(
                DATA_REPO_RELEASE_WORKFLOW_VERSION,
            );
        });

        it('reads an older revision back', () => {
            const older = DATA_REPO_RELEASE_WORKFLOW.replace(
                'x-ever-works-workflow-version: 1',
                'x-ever-works-workflow-version: 0',
            );

            expect(parseReleaseWorkflowVersion(older)).toBe(0);
        });

        it('treats a file without the marker as owner-authored', () => {
            const adopted = DATA_REPO_RELEASE_WORKFLOW.replace(
                `# x-ever-works-workflow: ${DATA_REPO_RELEASE_WORKFLOW_MARKER}\n`,
                '',
            );

            expect(isManagedReleaseWorkflow(adopted)).toBe(false);
            expect(parseReleaseWorkflowVersion(adopted)).toBeNull();
        });

        it('does not match a marker for some other managed workflow', () => {
            const other = DATA_REPO_RELEASE_WORKFLOW.replace(
                `# x-ever-works-workflow: ${DATA_REPO_RELEASE_WORKFLOW_MARKER}`,
                '# x-ever-works-workflow: something-else',
            );

            expect(isManagedReleaseWorkflow(other)).toBe(false);
            expect(parseReleaseWorkflowVersion(other)).toBeNull();
        });

        it('ignores the marker when it is not on its own comment line', () => {
            // A repository that merely mentions the marker in prose must not
            // be mistaken for a managed copy.
            expect(isManagedReleaseWorkflow('name: CI\n# see x-ever-works-workflow: ci\n')).toBe(
                false,
            );
            expect(isManagedReleaseWorkflow('name: x-ever-works-workflow: data-repo-release')).toBe(
                false,
            );
        });

        it('returns null when a managed copy carries no readable version', () => {
            const noVersion = DATA_REPO_RELEASE_WORKFLOW.replace(
                '# x-ever-works-workflow-version: 1\n',
                '',
            );

            expect(isManagedReleaseWorkflow(noVersion)).toBe(true);
            expect(parseReleaseWorkflowVersion(noVersion)).toBeNull();
        });
    });
});
