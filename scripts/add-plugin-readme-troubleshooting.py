#!/usr/bin/env python3
"""
Add a Troubleshooting section to each plugin README under packages/plugins/<id>/README.md.

The section is inserted directly before the "## Local development" heading so existing
content (Settings, How it works, etc.) is left untouched. Plugins whose README already
contains a "## Troubleshooting" heading are left alone (idempotent).

Sections are tailored per category. Within a category, the table rows are templated
on the plugin id, capability list, and human-readable name (derived from package.json).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

PLUGINS_DIR = Path(__file__).resolve().parent.parent / "packages" / "plugins"


def load_plugin(pkg_dir: Path) -> dict | None:
    pkg_json = pkg_dir / "package.json"
    if not pkg_json.exists():
        return None
    data = json.loads(pkg_json.read_text(encoding="utf-8"))
    plugin = data.get("everworks", {}).get("plugin", {})
    if not plugin:
        return None
    return {
        "id": plugin["id"],
        "name": plugin.get("name", plugin["id"]),
        "category": plugin.get("category", "unknown"),
        "capabilities": plugin.get("capabilities", []),
        "pkg_name": data.get("name", f"@ever-works/{plugin['id']}-plugin"),
        "dir": pkg_dir,
    }


def env_var(plugin_id: str, suffix: str) -> str:
    return f"PLUGIN_{plugin_id.upper().replace('-', '_')}_{suffix}"


def troubleshooting_for(plugin: dict) -> str:
    pid = plugin["id"]
    name = plugin["name"]
    cat = plugin["category"]
    caps = plugin["capabilities"]
    api_key_env = env_var(pid, "API_KEY")

    rows: list[tuple[str, str, str]] = []

    if cat == "search":
        rows.append((
            f"`401 Unauthorized` / `Authentication failed`",
            f"API key missing, revoked, or wrong key entered",
            f"Re-enter the **API Key** from the {name} dashboard, or set `{api_key_env}` in the host environment for default fallback",
        ))
        rows.append((
            "`429 Too Many Requests`",
            f"Free-tier or paid quota exhausted on {name}",
            f"Throttle calls, wait for the quota reset, or upgrade the plan in the {name} dashboard",
        ))
        rows.append((
            "Empty / sparse results",
            "Query is too restrictive, time-range or domain filters are too narrow",
            "Broaden the query, relax `time_range` / `safesearch` / `include_domains` / `exclude_domains` filters, or raise `max_results`",
        ))
        rows.append((
            "Plugin not used during work generation",
            "Another search plugin is set as the default for the `search` capability",
            f"In **Settings → Plugins**, set `{pid}` as the default for `search`, or disable competing search plugins",
        ))
        if "content-extractor" in caps:
            rows.append((
                "`Failed to extract content` for a URL",
                "Page is gated by login, Cloudflare, or robots.txt; URL is malformed",
                "Verify the URL is publicly reachable; for protected pages enable a different `content-extractor` plugin (`scrapfly`, `notion-extractor`, `pdf-extractor`)",
            ))
        rows.append((
            "`healthCheck` reports unhealthy",
            f"API key invalid OR {name} endpoint unreachable from the host",
            f"Verify the key with a manual `curl` against the documented endpoint and confirm outbound HTTPS is allowed by the firewall",
        ))

    elif cat == "content-extractor":
        rows.append((
            "`401` / `403` from the extractor",
            "API key / token missing or revoked",
            f"Re-enter the credential from the {name} dashboard, or set `{api_key_env}` in the host environment for default fallback",
        ))
        rows.append((
            "`Failed to extract content` for a specific URL",
            "Page requires authentication, JavaScript rendering, or a custom client (Notion, PDF, login wall)",
            f"Verify the URL is publicly reachable; if it requires JavaScript/auth, switch to a more capable extractor (`scrapfly` / `notion-extractor` / `pdf-extractor`) for that URL",
        ))
        rows.append((
            "Plugin not used during extraction",
            "Another content-extractor plugin is set as the default",
            f"In **Settings → Plugins**, set `{pid}` as the default for `content-extractor`, or disable competing plugins",
        ))
        if pid == "local-content-extractor":
            rows.append((
                "Returned content is missing main article",
                "Page uses non-standard markup or JavaScript-rendered content",
                "Switch to `scrapfly` or `firecrawl` for that URL — `local-content-extractor` does no JS rendering",
            ))
        if pid == "notion-extractor":
            rows.append((
                "`Notion API error: object_not_found`",
                "Page not shared with the integration token",
                "In Notion, open the page → **Share** → **Add connections** and grant the integration access",
            ))
        if pid == "pdf-extractor":
            rows.append((
                "Garbled / empty text from a scanned PDF",
                "PDF is image-only; this extractor does not OCR",
                "Pre-process the PDF through OCR (e.g. `ocrmypdf`) before passing the URL, or use a service that includes OCR",
            ))
        rows.append((
            "`healthCheck` reports unhealthy",
            f"Credential invalid OR {name} endpoint unreachable from the host",
            "Verify the credential with a manual call to the upstream API and confirm outbound HTTPS is allowed by the firewall",
        ))

    elif cat == "screenshot":
        rows.append((
            "`401` / `Authentication failed`",
            "API key (or signing secret) missing or wrong",
            f"Re-enter the credential(s) from the {name} dashboard, or set `{api_key_env}` (and signing-secret env var if applicable) for default fallback",
        ))
        rows.append((
            "Black / blank / `null` `imageUrl` returned",
            "Target page failed to render within the configured timeout, or is blocked by anti-bot protection",
            "Increase the timeout, enable wait-for-network-idle / `full_page` mode, or set a custom `user_agent` and `viewport`",
        ))
        rows.append((
            "Plugin not used for screenshot capture",
            "Another screenshot plugin is set as the default",
            f"In **Settings → Plugins**, set `{pid}` as the default for `screenshot`, or disable competing plugins",
        ))
        rows.append((
            "Quota exhausted / `429`",
            f"Monthly / per-minute screenshot cap reached on {name}",
            f"Throttle calls, wait for the quota reset, or upgrade the plan in the {name} dashboard",
        ))
        rows.append((
            "`healthCheck` reports unhealthy",
            f"Credential invalid OR {name} endpoint unreachable from the host",
            "Verify the credential with a manual call to the upstream API and confirm outbound HTTPS is allowed by the firewall",
        ))

    elif cat in {"ai-provider"}:
        rows.append((
            "`401` / `Invalid API key`",
            "API key missing, revoked, or scoped to a different organization",
            f"Re-enter the **API Key** from the {name} dashboard; verify the org/project, or set the documented `PLUGIN_*_API_KEY` env var as a default fallback",
        ))
        rows.append((
            "`429 Too Many Requests` / rate-limit errors",
            f"{name} per-minute, per-token, or per-account quota exhausted",
            f"Reduce concurrency, request a quota increase in the {name} console, or set a smaller `Max Tokens` / lower-cost model for the affected tier",
        ))
        rows.append((
            "`Model not found` / `400 invalid model`",
            "Model id is not enabled for this account, region, or beta program",
            f"Pick an enabled model in the {name} dashboard, or set the **Default Model** field to one your account has access to",
        ))
        rows.append((
            "Empty / truncated AI output",
            "**Max Tokens** too low, **Temperature** too low for creative tasks, or context window exceeded",
            "Raise **Max Tokens**, raise **Temperature** for creative work, or split the input into smaller batches",
        ))
        rows.append((
            "Plugin not selected during generation",
            "Another AI provider plugin is set as the default for `ai-provider`",
            f"In **Settings → Plugins**, set `{pid}` as the default for `ai-provider`, or disable competing AI plugins",
        ))
        rows.append((
            "`healthCheck` reports unhealthy",
            f"API key invalid OR {name} endpoint unreachable from the host",
            f"Verify the key with a `curl` against the documented chat/completions endpoint and confirm outbound HTTPS is allowed by the firewall",
        ))

    elif cat == "deployment":
        if pid == "vercel":
            rows.append((
                "`401 Unauthorized` from Vercel",
                "API token missing, expired, or scoped to a different account/team",
                "Re-issue a token at [vercel.com/account/tokens](https://vercel.com/account/tokens) and re-enter it; if deploying under a team, set **Team ID** / `DEPLOY_TEAM_SCOPE` to the team slug",
            ))
            rows.append((
                "Deployment never reaches `READY` (stuck `BUILDING`)",
                "Vercel build script failing OR `DEPLOY_PROVIDER`/`DATA_REPOSITORY` GitHub Actions secret not set on the work's repository",
                "Open the Vercel build log for the failing deployment; in the work's GitHub repo verify the four required Actions secrets exist (`TENANT_ID`, `DATA_REPOSITORY`, `VERCEL_TOKEN`, `DEPLOY_TOKEN`)",
            ))
            rows.append((
                "`Domain mismatch` after binding a custom domain",
                "Domain not yet attached to the Vercel project, or DNS still propagating",
                "In the Vercel dashboard add the domain to the deployed project, then re-run domain verification from Ever Works (gives DNS up to 48h to propagate)",
            ))
        elif pid == "k8s":
            rows.append((
                "`Forbidden` / `Unauthorized` from the cluster",
                "Service-account token missing or RBAC permissions too narrow",
                "Re-issue a long-lived service-account token with the documented Role/RoleBinding and re-enter it; verify with `kubectl auth can-i create deployments --as=system:serviceaccount:<ns>:<sa>`",
            ))
            rows.append((
                "Deployment stuck in `Pending` / `ImagePullBackOff`",
                "Image not yet pushed to the configured registry, or imagePullSecret missing",
                "Push the image and verify the registry is reachable from the cluster; ensure the namespace has a valid imagePullSecret referenced by the deployment",
            ))
            rows.append((
                "`x509: certificate signed by unknown authority`",
                "Custom CA on the API server not bundled into the kubeconfig",
                "Provide the CA bundle in the **Kubeconfig** setting, or set `KUBECONFIG_INSECURE=true` only in non-production environments",
            ))
        rows.append((
            "Plugin not selected during deployment",
            "Another deployment plugin is set as the default",
            f"In **Settings → Plugins**, set `{pid}` as the default for `deployment`, or disable competing plugins",
        ))
        rows.append((
            "`healthCheck` reports unhealthy",
            f"Credential invalid OR {name} endpoint unreachable from the host",
            "Verify the credential against the upstream API and confirm outbound HTTPS / cluster API connectivity is allowed",
        ))

    elif cat == "git-provider":
        rows.append((
            "`401 Bad credentials` / `Resource not accessible by integration`",
            "OAuth app misconfigured, token revoked, or the GitHub App is not installed on the target repository",
            "Verify **Client ID** / **Client Secret** match the GitHub OAuth App, or install the GitHub App on the target repository; check `PLUGIN_GITHUB_CLIENT_ID` / `PLUGIN_GITHUB_CLIENT_SECRET` env-var fallbacks",
        ))
        rows.append((
            "OAuth login redirects loop or returns `state mismatch`",
            "Callback URL mismatch between the OAuth App and the configured `webAppUrl`",
            "In the GitHub OAuth App settings, set the callback to `<webAppUrl>/api/auth/callback/github`; confirm `webAppUrl` in `apps/api` matches the URL used by the browser",
        ))
        rows.append((
            "Repository creation fails with `name already exists`",
            "Slug collision in the user's namespace",
            "Pick a unique slug or delete the conflicting repository in GitHub before re-running the work creation",
        ))
        rows.append((
            "Webhook payloads not received",
            "Webhook signature secret mismatch or webhook URL not reachable",
            "Confirm `GITHUB_APP_WEBHOOK_SECRET` matches the value in the GitHub App settings; expose `/api/github-app/webhooks` to GitHub (use a tunnel for local dev)",
        ))
        rows.append((
            "GitHub Enterprise instance — calls fail with `404`",
            "API base URL still points to public GitHub",
            "Set **API Base URL** to the GHES API endpoint, e.g. `https://github.example.com/api/v3`",
        ))

    elif cat == "data-source":
        rows.append((
            "`401 Unauthorized`",
            "API token missing or revoked",
            f"Re-issue the API token from the {name} console and re-enter it; or set `{api_key_env}` for default fallback",
        ))
        rows.append((
            "Actor / dataset returns no items",
            "Actor input misconfigured, dataset filter too restrictive, or run timed out",
            f"In the {name} dashboard re-run the actor manually with the same input, inspect the run log, then adjust input fields and retry",
        ))
        rows.append((
            "Plugin not used as data source",
            "Another data-source plugin is set as the default",
            f"In **Settings → Plugins**, set `{pid}` as the default for `data-source`, or disable competing plugins",
        ))
        rows.append((
            "`healthCheck` reports unhealthy",
            f"Credential invalid OR {name} endpoint unreachable from the host",
            "Verify the credential against the upstream API and confirm outbound HTTPS is allowed by the firewall",
        ))

    elif cat == "pipeline":
        cap_label = "the active pipeline"
        rows.append((
            "Generation never starts / stays at `0%`",
            f"`{pid}` not selected as the active pipeline plugin for this work",
            f"Open the work → **Plugins** → `pipeline` capability and set `{pid}` as the active pipeline; or set it as the global pipeline default in **Settings → Plugins**",
        ))
        rows.append((
            "Step fails with `No AI / search / screenshot provider configured`",
            "Pipeline depends on capability plugins that are not enabled or have no credentials",
            "Enable and configure the matching capability plugin (AI provider, search, screenshot, content-extractor) for the work or globally",
        ))
        rows.append((
            "Step output looks wrong / generic",
            "Form-field tuning not set; pipeline using defaults that don't match the work's domain",
            "Open the **Generator Form** for the work, set domain-specific fields (categories, target keywords, source URLs), and re-run the affected step",
        ))
        if pid in {"claude-code", "codex", "gemini", "opencode"}:
            rows.append((
                "Subprocess error: `command not found`",
                f"`{name}` CLI not installed on the host running the API",
                f"Install the {name} CLI on the API host and ensure it is on `PATH`; verify by running `which <cli>` from the same shell that launches `pnpm dev:api`",
            ))
            rows.append((
                "Authentication / device-auth flow stalls",
                "Device-auth code never confirmed in the upstream IDE / browser",
                "Re-run the device-auth flow from **Settings → Plugins → " + pid + " → Connect**, then complete the prompt in the upstream service before the code expires",
            ))
        if pid in {"make", "zapier", "sim-ai", "activepieces", "agent-pipeline"}:
            rows.append((
                "Webhook returns `404` / `Not Found`",
                "Scenario / Zap not enabled or webhook URL stale",
                f"In the {name} dashboard verify the scenario is **active**, copy a fresh webhook URL into the plugin settings, and trigger a test run",
            ))
        rows.append((
            "Pipeline cannot resume after host restart",
            "Checkpoint not persisted (only the standard pipeline persists checkpoints today)",
            "Cancel the stuck run and re-trigger generation; for production reliability prefer `standard-pipeline`",
        ))

    elif cat == "utility":
        if pid == "comparison-generator":
            rows.append((
                "Comparison generation fails with `No AI provider configured`",
                "No AI-provider plugin enabled with a valid API key",
                "Enable an AI-provider plugin (`openai`, `anthropic`, `google`, `groq`, `mistral`, `ollama`) and add its API key",
            ))
            rows.append((
                "Comparison missing data for one of the items",
                "Item is missing a `description` or `source_url`",
                "Edit the item to populate description and source URL, then re-run the comparison",
            ))
            rows.append((
                "Manual comparison endpoint returns `Items must be different`",
                "Same `itemASlug` and `itemBSlug` passed",
                "Pick two distinct item slugs in the comparison form",
            ))
            rows.append((
                "Comparison scheduler not generating new comparisons",
                "Cron disabled, or the work has no remaining comparisons left in its quota",
                "Verify scheduler activity log; check `getRemainingComparisonCount` for the work — increase the quota or enable a higher subscription plan",
            ))
        elif pid == "langfuse":
            rows.append((
                "`401 Unauthorized` from Langfuse",
                "Public/secret key missing or wrong project",
                "Re-issue keys at the Langfuse dashboard and re-enter both **Public Key** and **Secret Key**; or set `PLUGIN_LANGFUSE_PUBLIC_KEY` / `PLUGIN_LANGFUSE_SECRET_KEY` env vars",
            ))
            rows.append((
                "Prompts not appearing in Langfuse",
                "Plugin not enabled OR `host` URL points to wrong region",
                "Enable the plugin globally; verify **Host** matches the dashboard region (`https://cloud.langfuse.com` for US, `https://cloud.langfuse.eu` for EU)",
            ))
            rows.append((
                "`healthCheck` reports unhealthy",
                f"Credentials invalid OR {name} endpoint unreachable from the host",
                "Verify the credentials with a `curl` against the documented `/api/public/health` endpoint and confirm outbound HTTPS is allowed",
            ))

    if not rows:
        return ""

    md = ["", "## Troubleshooting", ""]
    md.append("| Symptom | Likely cause | Fix |")
    md.append("| ------- | ------------ | --- |")
    for symptom, cause, fix in rows:
        md.append(f"| {symptom} | {cause} | {fix} |")
    md.append("")
    return "\n".join(md)


def insert_section(readme: Path, section_md: str) -> bool:
    text = readme.read_text(encoding="utf-8")
    if "## Troubleshooting" in text:
        return False
    # Insert directly before "## Local development"
    pattern = re.compile(r"(?=^## Local development\b)", flags=re.MULTILINE)
    new_text, count = pattern.subn(section_md.lstrip("\n") + "\n", text, count=1)
    if count == 0:
        # Fallback: insert before "## Documentation"
        pattern = re.compile(r"(?=^## Documentation\b)", flags=re.MULTILINE)
        new_text, count = pattern.subn(section_md.lstrip("\n") + "\n", text, count=1)
    if count == 0:
        # Last resort: append at end before final license
        new_text = text.rstrip() + "\n\n" + section_md.lstrip("\n") + "\n"
    readme.write_text(new_text, encoding="utf-8")
    return True


def main() -> int:
    changed: list[str] = []
    skipped: list[str] = []
    no_section: list[str] = []

    for pkg_dir in sorted(PLUGINS_DIR.iterdir()):
        if not pkg_dir.is_dir():
            continue
        plugin = load_plugin(pkg_dir)
        if not plugin:
            continue
        readme = pkg_dir / "README.md"
        if not readme.exists():
            continue
        section_md = troubleshooting_for(plugin)
        if not section_md:
            no_section.append(plugin["id"])
            continue
        if insert_section(readme, section_md):
            changed.append(plugin["id"])
        else:
            skipped.append(plugin["id"])

    print(f"Updated:    {len(changed)} -> {', '.join(changed) if changed else '(none)'}")
    print(f"Skipped:    {len(skipped)} -> {', '.join(skipped) if skipped else '(none)'}")
    print(f"No section: {len(no_section)} -> {', '.join(no_section) if no_section else '(none)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
