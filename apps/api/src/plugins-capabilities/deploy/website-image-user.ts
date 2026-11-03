/**
 * The NUMERIC uid / gid a Work's website image runs as, when the platform can vouch for it.
 *
 * The Kubernetes plugin enforces `runAsNonRoot` + this uid / gid + `capabilities.drop: [ALL]` only
 * when it is told the user (see `buildDeployment` in packages/plugins/k8s). It must NOT be told
 * for an image that starts as root:
 *
 * - `ever-works/directory-web-template` and `ever-works/web-template` (Next.js) build from the
 *   official Node image and end with `USER node` = 1000:1000 -> enforce it.
 * - `ever-works/directory-web-minimal-template` and `ever-works/web-minimal-template` (Astro) serve
 *   with stock `nginx:<ver>-alpine`, whose master runs as root. As uid 1000 it cannot write
 *   /var/cache/nginx or its pid file; as root with ALL capabilities dropped it cannot setuid its
 *   workers. Either way the pod crash-loops.
 *
 * Every Work repo holds its OWN copy of the Dockerfile, generated from the template and free to
 * diverge from it afterwards (and a Work with no pinned template resolves through its owner's
 * CURRENT saved default, which may not be what it was generated from). So the user is enforced
 * only when BOTH agree: the template is one known to run as `node`, AND the Work's own Dockerfile
 * still ends in a `FROM node…` stage with `USER node` / `USER 1000`. Anything else (the minimal
 * templates, a custom catalog template, a fork under another owner, a diverged or unreadable
 * Dockerfile) gets `null`: no user forced, while the root-safe hardening (no SA token,
 * RuntimeDefault seccomp, no privilege escalation) still applies.
 */
export interface WebsiteImageUser {
    uid: number;
    gid: number;
}

const NODE_USER: WebsiteImageUser = { uid: 1000, gid: 1000 };

/** `owner/repo` (lower-case) of the templates whose runner stage ends in `USER node`. */
const NODE_USER_TEMPLATE_REPOS: ReadonlySet<string> = new Set([
    'ever-works/directory-web-template',
    'ever-works/web-template',
]);

/** Image names (lower-case, no tag / digest) of the official Node image. */
const NODE_BASE_IMAGES: ReadonlySet<string> = new Set([
    'node',
    'library/node',
    'docker.io/node',
    'docker.io/library/node',
]);

/** USER / group values that are the official Node image's `node` user (1000:1000). */
const NODE_USER_IDS: ReadonlySet<string> = new Set(['node', '1000']);

type TemplateRef = { owner?: string | null; repo?: string | null } | null | undefined;

/** Whether the Work's template is one whose image runs as `node` (worth reading the Dockerfile for). */
export function isNodeUserTemplate(template: TemplateRef): boolean {
    const owner = template?.owner?.trim().toLowerCase();
    const repo = template?.repo?.trim().toLowerCase();
    return !!owner && !!repo && NODE_USER_TEMPLATE_REPOS.has(`${owner}/${repo}`);
}

/**
 * The final build stage's base image and its last `USER` (null when the stage sets none), or null
 * when there is no `FROM` at all. The built image is the final stage: k8s-build.yml passes no
 * `--target`. Line continuations are joined, comments skipped and heredoc bodies ignored, so a
 * `user nginx;` line inside an inlined config is never mistaken for a USER instruction.
 */
export function parseFinalStage(dockerfile: string): { base: string; user: string | null } | null {
    const lines = dockerfile.replace(/\r\n?/g, '\n').split('\n');
    let stage: { base: string; user: string | null } | null = null;
    let heredocEnd: string | null = null;
    let pending = '';

    for (const raw of lines) {
        if (heredocEnd !== null) {
            if (raw.trim() === heredocEnd) heredocEnd = null;
            continue;
        }
        if (!pending && /^\s*#/.test(raw)) continue;
        if (/\\\s*$/.test(raw)) {
            pending += raw.replace(/\\\s*$/, ' ');
            continue;
        }
        const line = (pending + raw).trim();
        pending = '';
        if (!line) continue;

        const heredoc = /<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/.exec(line);
        if (heredoc) heredocEnd = heredoc[1];

        const match = /^(\w+)\s+(.*)$/.exec(line);
        if (!match) continue;
        const instruction = match[1].toUpperCase();
        const args = match[2].trim().split(/\s+/);
        if (instruction === 'FROM') {
            const image = args.find((arg) => !arg.startsWith('--')) ?? '';
            stage = { base: image, user: null };
        } else if (instruction === 'USER' && stage) {
            stage.user = args[0] ?? null;
        }
    }
    return stage;
}

/** Whether a Dockerfile's final stage runs as the official Node image's `node` user. */
export function dockerfileRunsAsNodeUser(dockerfile: string | null | undefined): boolean {
    if (!dockerfile) return false;
    const stage = parseFinalStage(dockerfile);
    if (!stage?.user) return false;
    // `node:${NODE_VERSION}` -> `node`; `docker.io/library/node@sha256:…` -> `docker.io/library/node`.
    const imageName = stage.base
        .toLowerCase()
        .split('@')[0]
        .replace(/:[^/]*$/, '');
    if (!NODE_BASE_IMAGES.has(imageName)) return false;
    const [user, group, ...rest] = stage.user.split(':');
    if (rest.length > 0 || !NODE_USER_IDS.has(user)) return false;
    return group === undefined || NODE_USER_IDS.has(group);
}

export function resolveWebsiteImageUser(
    template: TemplateRef,
    dockerfile: string | null | undefined,
): WebsiteImageUser | null {
    if (!isNodeUserTemplate(template)) return null;
    return dockerfileRunsAsNodeUser(dockerfile) ? { ...NODE_USER } : null;
}
