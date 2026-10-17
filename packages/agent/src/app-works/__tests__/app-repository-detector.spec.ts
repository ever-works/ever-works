import { validateAppSpecDocument } from '../../works-config/schema/app-spec.validate';
import {
    detectAppRepository,
    draftAppSpecDocument,
    parseDockerfile,
    parseEnvNames,
} from '../app-repository-detector';

/** APW-04 — repository detection and the first App spec (the AI provisioner's evidence). */

const SOURCE_FILE = [
    'version: 2',
    'kind: app',
    'name: helpdesk',
    'spec:',
    '    source:',
    '        relation: fork',
    '        upstream:',
    '            repo: example-org/helpdesk',
    '            defaultBranch: main',
    '',
].join('\n');

describe('detectAppRepository + draftAppSpecDocument (APW-04)', () => {
    it('detects a Dockerfile app with Postgres and Redis from compose, and drafts a valid spec', () => {
        const detection = detectAppRepository({
            rootEntries: [
                'Dockerfile',
                'docker-compose.yml',
                'package.json',
                'pnpm-lock.yaml',
                '.env.example',
                '.works',
            ],
            files: {
                '.works/works.yml': SOURCE_FILE,
                Dockerfile: [
                    'FROM node:22-slim AS deps',
                    'FROM node:22-slim AS builder',
                    'FROM node:22-slim AS runner',
                    'EXPOSE 3000',
                    'HEALTHCHECK CMD curl -f http://localhost:3000/api/health || exit 1',
                ].join('\n'),
                'docker-compose.yml': [
                    'services:',
                    '  app:',
                    '    build: .',
                    '    ports: ["8080:3000"]',
                    '  db:',
                    '    image: postgres:16',
                    '  cache:',
                    '    image: redis:7',
                ].join('\n'),
                'package.json': JSON.stringify({
                    dependencies: { next: '15.0.0', pg: '8.0.0', ioredis: '5.0.0' },
                    scripts: { start: 'next start' },
                }),
                '.env.example': [
                    'DATABASE_URL=postgres://localhost/app',
                    'REDIS_URL=redis://localhost',
                    'NEXTAUTH_SECRET=changeme',
                    'NEXTAUTH_URL=http://localhost:3000',
                    'GITHUB_CLIENT_SECRET=',
                    'NEXT_PUBLIC_ANALYTICS_ID=',
                ].join('\n'),
            },
        });

        expect(detection).toMatchObject({
            existingSpec: true,
            dockerfile: 'Dockerfile',
            composeFile: 'docker-compose.yml',
            language: 'node',
            packageManager: 'pnpm',
            framework: 'next',
            port: 3000,
            healthPath: '/api/health',
            buildStrategy: 'dockerfile',
            runnable: true,
        });
        expect(detection.dependencies).toEqual(['postgres', 'redis']);

        const draft = draftAppSpecDocument(detection, {
            name: 'Helpdesk',
            existingText: SOURCE_FILE,
        });
        const result = validateAppSpecDocument(draft, { mode: 'data-repository' });
        expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
        expect(result.spec).not.toBeNull();
        // The owned `source` block is carried over verbatim.
        expect(result.spec?.source).toEqual({
            relation: 'fork',
            upstream: { repo: 'example-org/helpdesk', defaultBranch: 'main' },
        });
        // Secrets are never literal values.
        expect(draft).not.toContain('changeme');
        expect(draft).toContain('deps.postgres.url');
        expect(draft).toContain('domains.primary.url');
    });

    it('falls back to build.strategy auto for a manifest-only Python app', () => {
        const detection = detectAppRepository({
            rootEntries: ['pyproject.toml', 'manage.py'],
            files: {
                'pyproject.toml': '[project]\ndependencies = ["django>=5", "psycopg[binary]"]\n',
            },
        });
        expect(detection).toMatchObject({
            language: 'python',
            framework: 'django',
            buildStrategy: 'auto',
            port: 8000,
        });
        expect(detection.dependencies).toEqual(['postgres']);
        const draft = draftAppSpecDocument(detection, {
            name: 'Shop',
            source: { relation: 'link' },
        });
        const result = validateAppSpecDocument(draft, { mode: 'data-repository' });
        expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    });

    it('reports a library as not runnable', () => {
        const detection = detectAppRepository({ rootEntries: ['README.md', 'LICENSE'], files: {} });
        expect(detection.runnable).toBe(false);
        expect(detection.buildStrategy).toBe('none');
    });

    it('parses Dockerfile EXPOSE / stages and env names', () => {
        expect(
            parseDockerfile(
                'FROM a AS build\nFROM b AS production\nFROM c AS debug\nEXPOSE 8080/tcp 9000',
            ),
        ).toEqual({
            ports: [8080, 9000],
            target: 'production',
            healthPath: null,
        });
        expect(parseEnvNames('# c\nexport A=1\nB = 2\nlower=3\nEVER_WORKS_X=1\nA=dup')).toEqual([
            'A',
            'B',
        ]);
    });
});
