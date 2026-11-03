/**
 * The NUMERIC uid / gid a Work's website image runs as, when the platform knows it.
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
 * Every Work repo holds its OWN copy of the Dockerfile from when it was generated, so changing a
 * template repo cannot fix existing Works: only an allow-list of templates known to run as `node`
 * is enforced. Anything else (the minimal templates, a custom catalog template, a fork under
 * another owner, an unresolvable template) gets `null`: no user forced, the root-safe hardening
 * (no SA token, RuntimeDefault seccomp, no privilege escalation) still applies.
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

export function resolveWebsiteImageUser(
    template: { owner?: string | null; repo?: string | null } | null | undefined,
): WebsiteImageUser | null {
    const owner = template?.owner?.trim().toLowerCase();
    const repo = template?.repo?.trim().toLowerCase();
    if (!owner || !repo) return null;
    return NODE_USER_TEMPLATE_REPOS.has(`${owner}/${repo}`) ? { ...NODE_USER } : null;
}
