import {
    dockerfileRunsAsNodeUser,
    isNodeUserTemplate,
    parseFinalStage,
    resolveWebsiteImageUser,
} from './website-image-user';

// Trimmed copies of the real runner stages (2026-11-03).
const NEXT_DOCKERFILE = `# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=26.12.1-alpine
FROM node:\${NODE_VERSION} AS base
RUN corepack enable
FROM base AS installer
USER root
RUN pnpm build
FROM node:\${NODE_VERSION} AS runner
WORKDIR /app
COPY --from=installer --chown=node:node /app/.next/standalone ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
`;

const NGINX_DOCKERFILE = `ARG NODE_VERSION=26.12.1-alpine
ARG NGINX_VERSION=1.27-alpine
FROM node:\${NODE_VERSION} AS builder
USER node
RUN pnpm build
FROM nginx:\${NGINX_VERSION} AS runner
RUN cat > /etc/nginx/conf.d/default.conf <<'EOF'
server {
    listen 3000;
}
EOF
COPY --from=builder /work/apps/web/dist /usr/share/nginx/html
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
`;

describe('parseFinalStage', () => {
    it('answers the LAST stage, ignoring USER lines of earlier stages', () => {
        expect(parseFinalStage(NEXT_DOCKERFILE)).toEqual({
            base: 'node:${NODE_VERSION}',
            user: 'node',
        });
        expect(parseFinalStage(NGINX_DOCKERFILE)).toEqual({
            base: 'nginx:${NGINX_VERSION}',
            user: null,
        });
    });

    it('never reads a heredoc body (an inlined nginx.conf `user nginx;`) as an instruction', () => {
        const dockerfile = `FROM nginx:1.27-alpine
RUN cat > /etc/nginx/nginx.conf <<EOF
user node;
EOF
`;
        expect(parseFinalStage(dockerfile)).toEqual({ base: 'nginx:1.27-alpine', user: null });
    });

    it('skips --platform flags and comments, joins continuations, is case-insensitive', () => {
        const dockerfile = `# USER root
from --platform=$BUILDPLATFORM node:26-alpine as runner
RUN echo a \\
    && echo b
user node
`;
        expect(parseFinalStage(dockerfile)).toEqual({ base: 'node:26-alpine', user: 'node' });
    });

    it('answers null with no FROM at all', () => {
        expect(parseFinalStage('')).toBeNull();
        expect(parseFinalStage('# nothing here\n')).toBeNull();
    });
});

describe('dockerfileRunsAsNodeUser', () => {
    it('accepts the Next.js templates and node / 1000 spellings on the official Node image', () => {
        expect(dockerfileRunsAsNodeUser(NEXT_DOCKERFILE)).toBe(true);
        for (const user of ['node', '1000', '1000:1000', 'node:node']) {
            expect(dockerfileRunsAsNodeUser(`FROM node:26-alpine\nUSER ${user}\n`)).toBe(true);
        }
        expect(
            dockerfileRunsAsNodeUser('FROM docker.io/library/node@sha256:abc\nUSER node\n'),
        ).toBe(true);
    });

    it.each([
        ['stock nginx, no USER (root)', NGINX_DOCKERFILE],
        ['USER root on node', 'FROM node:26-alpine\nUSER root\n'],
        ['no USER on node (root)', 'FROM node:26-alpine\nCMD ["node"]\n'],
        ['a different uid', 'FROM node:26-alpine\nUSER 1001\n'],
        ['a variable user', 'FROM node:26-alpine\nUSER ${APP_USER}\n'],
        ['a non-Node base', 'FROM nginxinc/nginx-unprivileged:1.27-alpine\nUSER 101\n'],
        ['a stage alias as base', 'FROM node:26-alpine AS base\nFROM base\nUSER node\n'],
    ])('rejects %s', (_label, dockerfile) => {
        expect(dockerfileRunsAsNodeUser(dockerfile)).toBe(false);
    });

    it('rejects a missing Dockerfile', () => {
        expect(dockerfileRunsAsNodeUser(null)).toBe(false);
        expect(dockerfileRunsAsNodeUser(undefined)).toBe(false);
        expect(dockerfileRunsAsNodeUser('')).toBe(false);
    });
});

describe('resolveWebsiteImageUser', () => {
    it.each([
        ['ever-works', 'directory-web-template'],
        ['ever-works', 'web-template'],
        ['Ever-Works', 'Directory-Web-Template'],
    ])('%s/%s (Next.js, `USER node`) with its Dockerfile intact → 1000:1000', (owner, repo) => {
        expect(isNodeUserTemplate({ owner, repo })).toBe(true);
        expect(resolveWebsiteImageUser({ owner, repo }, NEXT_DOCKERFILE)).toEqual({
            uid: 1000,
            gid: 1000,
        });
    });

    // A node template whose Work repo no longer runs as node (or cannot be read): not forced.
    it.each([
        ['an nginx runner', NGINX_DOCKERFILE],
        ['USER root', 'FROM node:26-alpine\nUSER root\n'],
        ['an unreadable Dockerfile', null],
    ])('a node template whose Work Dockerfile has %s → no forced user', (_label, dockerfile) => {
        expect(
            resolveWebsiteImageUser(
                { owner: 'ever-works', repo: 'directory-web-template' },
                dockerfile,
            ),
        ).toBeNull();
    });

    // Stock nginx starts as root: forcing a user (or dropping ALL capabilities) crash-loops it.
    it.each([
        ['ever-works', 'directory-web-minimal-template'],
        ['ever-works', 'web-minimal-template'],
        // A fork or a custom catalog template: its Dockerfile is not ours to vouch for.
        ['someone-else', 'directory-web-template'],
        ['ever-works', 'my-custom-template'],
    ])('%s/%s → no forced user, even with a node Dockerfile', (owner, repo) => {
        expect(isNodeUserTemplate({ owner, repo })).toBe(false);
        expect(resolveWebsiteImageUser({ owner, repo }, NEXT_DOCKERFILE)).toBeNull();
    });

    it('answers null for a template without owner / repo', () => {
        expect(resolveWebsiteImageUser(null, NEXT_DOCKERFILE)).toBeNull();
        expect(resolveWebsiteImageUser(undefined, NEXT_DOCKERFILE)).toBeNull();
        expect(resolveWebsiteImageUser({ branch: 'main' } as never, NEXT_DOCKERFILE)).toBeNull();
        expect(
            resolveWebsiteImageUser({ owner: 'ever-works', repo: '' }, NEXT_DOCKERFILE),
        ).toBeNull();
    });
});
