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
 * still ends in a `FROM node…` stage with `USER node` / `USER 1000` that edits no accounts.
 * Anything else (the minimal templates, a custom catalog template, a fork under another owner, a
 * diverged or unreadable Dockerfile) gets `null`: no user forced, while the root-safe hardening
 * (no SA token, RuntimeDefault seccomp, no privilege escalation) still applies.
 *
 * The Dockerfile is the branch's CURRENT one, which can be ahead of the image behind the branch
 * alias the deploy pulls. So a `WebsiteImageUser` is only a proposal: the k8s plugin enforces it
 * only after `confirmImageUser` has read the `User` of the exact image it renders (see
 * `DeployService.deployServerSideManaged`).
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
 * A command (or a write to an account database) that can change what uid / gid `node` maps to, or
 * who else exists: `usermod -u 1001 node` keeps `USER node` while the image no longer runs as 1000.
 * Text matching cannot see every such change (a script copied in and run), so it only narrows the
 * risk; the image's own `User` is checked separately before anything is enforced.
 */
const ACCOUNT_EDIT_RE =
    /\b(?:usermod|groupmod|useradd|groupadd|adduser|addgroup|userdel|groupdel|deluser|delgroup|chpasswd|chgpasswd|newusers|vipw|vigr)\b|\/etc\/(?:passwd|group|shadow|gshadow)\b/i;

/** A COPY / ADD destination that overwrites an account database (or all of /etc). */
const ACCOUNT_FILE_DEST_RE = /^\/etc\/?$|^\/etc\/(?:passwd|group|shadow|gshadow)\/?$/i;

/** Instructions BuildKit accepts heredocs on. */
const HEREDOC_INSTRUCTIONS: ReadonlySet<string> = new Set(['RUN', 'COPY', 'ADD']);

export interface FinalStage {
    base: string;
    /** The stage's last `USER`, or null when it sets none. */
    user: string | null;
    /** Whether the stage edits accounts (see `ACCOUNT_EDIT_RE`), so `USER node` may not be 1000. */
    accountsEdited: boolean;
}

/**
 * The heredoc delimiters an instruction opens (`<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`), in order.
 * `<<` inside a quoted string (`echo '<<EOF'`) or escaped is text, not a heredoc, and `<<<` is a
 * here-string.
 */
export function heredocDelimiters(text: string): string[] {
    const found: string[] = [];
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) quote = null;
            else if (ch === '\\' && quote === '"') i++;
            continue;
        }
        if (ch === '\\') {
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch !== '<' || text[i + 1] !== '<') continue;
        if (text[i + 2] === '<') {
            i += 2;
            continue;
        }
        const opener = /^<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(text.slice(i));
        if (opener) {
            found.push(opener[2]);
            i += opener[0].length - 1;
        } else {
            i++;
        }
    }
    return found;
}

/**
 * The final build stage, or null when there is no `FROM` at all. The built image is the final
 * stage: k8s-build.yml passes no `--target`. Line continuations are joined, comments skipped and
 * heredoc bodies never read as instructions, so a `user nginx;` line inside an inlined config is
 * never mistaken for a USER instruction (a RUN heredoc body is still checked for account edits).
 */
export function parseFinalStage(dockerfile: string): FinalStage | null {
    const lines = dockerfile.replace(/\r\n?/g, '\n').split('\n');
    let stage: FinalStage | null = null;
    let heredocs: string[] = [];
    let heredocIsRun = false;
    let pending = '';

    for (const raw of lines) {
        if (heredocs.length > 0) {
            if (raw.trim() === heredocs[0]) heredocs.shift();
            else if (heredocIsRun && stage && ACCOUNT_EDIT_RE.test(raw))
                stage.accountsEdited = true;
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

        const match = /^(\w+)\s+(.*)$/.exec(line);
        if (!match) continue;
        const instruction = match[1].toUpperCase();
        const rest = match[2].trim();
        const args = rest.split(/\s+/);
        if (HEREDOC_INSTRUCTIONS.has(instruction)) {
            const delimiters = heredocDelimiters(rest);
            if (delimiters.length > 0) {
                heredocs = delimiters;
                heredocIsRun = instruction === 'RUN';
            }
        }

        if (instruction === 'FROM') {
            const image = args.find((arg) => !arg.startsWith('--')) ?? '';
            stage = { base: image, user: null, accountsEdited: false };
        } else if (!stage) {
            continue;
        } else if (instruction === 'USER') {
            stage.user = args[0] ?? null;
        } else if (instruction === 'RUN' && ACCOUNT_EDIT_RE.test(rest)) {
            stage.accountsEdited = true;
        } else if (
            (instruction === 'COPY' || instruction === 'ADD') &&
            ACCOUNT_FILE_DEST_RE.test(args[args.length - 1] ?? '')
        ) {
            stage.accountsEdited = true;
        }
    }
    return stage;
}

/**
 * Whether a `USER` value (`<user>[:<group>]`, from a Dockerfile or an image config's `User`) is the
 * official Node image's `node` user, 1000:1000.
 */
export function isNodeUserSpec(user: string | null | undefined): boolean {
    const raw = typeof user === 'string' ? user.trim() : '';
    if (!raw) return false;
    const [name, group, ...rest] = raw.split(':');
    if (rest.length > 0 || !NODE_USER_IDS.has(name)) return false;
    return group === undefined || NODE_USER_IDS.has(group);
}

/** Whether a Dockerfile's final stage runs as the official Node image's `node` user. */
export function dockerfileRunsAsNodeUser(dockerfile: string | null | undefined): boolean {
    if (!dockerfile) return false;
    const stage = parseFinalStage(dockerfile);
    if (!stage?.user || stage.accountsEdited) return false;
    // `node:${NODE_VERSION}` -> `node`; `docker.io/library/node@sha256:…` -> `docker.io/library/node`.
    const imageName = stage.base
        .toLowerCase()
        .split('@')[0]
        .replace(/:[^/]*$/, '');
    return NODE_BASE_IMAGES.has(imageName) && isNodeUserSpec(stage.user);
}

export function resolveWebsiteImageUser(
    template: TemplateRef,
    dockerfile: string | null | undefined,
): WebsiteImageUser | null {
    if (!isNodeUserTemplate(template)) return null;
    return dockerfileRunsAsNodeUser(dockerfile) ? { ...NODE_USER } : null;
}
