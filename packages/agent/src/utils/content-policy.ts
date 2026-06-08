/**
 * Content-policy scan for IMPORTED agent / skill instruction bodies
 * (EW-714 / decision D11).
 *
 * When an Agent or Skill is imported from a catalog or shared by another
 * user (sharing is a near-term feature), its instruction files (SOUL.md,
 * AGENTS.md, HEARTBEAT.md, TOOLS.md, skill `instructionsMd` / catalog body)
 * become part of the runtime system context. An attacker-authored share can
 * embed chat-template CONTROL TOKENS — the model's own turn-structure
 * delimiters — to break out of the "this is untrusted content" framing and
 * inject a forged `system` turn (prompt-injection / instruction hijack):
 *
 *   <|im_start|>system  …  <|im_end|>        (ChatML — OpenAI/Qwen/etc.)
 *   [INST] … [/INST]                          (Llama / Mistral instruct)
 *   <|system|> / <|user|> / <|assistant|>     (assorted chat templates)
 *   <s> / </s> tokens around an [INST] block
 *
 * These tokens are NEVER legitimate inside a human-authored markdown
 * instruction file — they are model-internal control sequences — so a
 * literal-marker scan has ~0 false positives while blocking the actual
 * takeover vector at the import boundary. This mirrors the hard-reject
 * posture of {@link ../utils/secret-scan} and the runtime
 * `CHAT_TEMPLATE_MARKER_PATTERN` neutralisation in `prompt-assembler`.
 *
 * Scope: this is a HARD-REJECT gate for the IMPORT path only. It does NOT
 * touch self-authored live edits (a user editing their OWN agent files is
 * a different trust boundary). A future LLM-judge content classifier can
 * layer on top for softer "jailbreak phrasing" heuristics — deliberately
 * out of scope here to keep the gate conservative and false-positive-free.
 */

export interface InjectionMatch {
    pattern: string;
    matched: string;
    index: number;
}

const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
    // ChatML control tokens (OpenAI/Qwen/Yi/…). The `<|...|>` form is the
    // canonical instruction-hijack vector in shared prompt content.
    {
        name: 'chatml_control_token',
        re: /<\|(?:im_start|im_end|system|user|assistant|endoftext|end|im_sep)\|>/gi,
    },
    // Llama / Mistral instruct delimiters.
    { name: 'inst_block', re: /\[\/?INST\]/gi },
    // Llama system-prompt block markers (often paired with [INST]).
    { name: 'llama_sys_block', re: /<<\/?SYS>>/gi },
    // Sentence-piece BOS/EOS used to frame a forged instruct turn. Require
    // proximity to an [INST] marker so a literal "<s>" in prose (rare in MD)
    // doesn't trip it on its own.
    { name: 'spm_inst_frame', re: /<\/?s>\s*\[\/?INST\]/gi },
];

/** Scan `body` for injection control-token patterns. Empty array = clean. */
export function scanForInjection(body: string): InjectionMatch[] {
    if (!body) return [];
    const out: InjectionMatch[] = [];
    for (const { name, re } of PATTERNS) {
        const r = new RegExp(re.source, re.flags); // fresh state per call
        let m: RegExpExecArray | null;
        while ((m = r.exec(body)) !== null) {
            out.push({ pattern: name, matched: truncateForDisplay(m[0]), index: m.index });
        }
    }
    return out;
}

/** True if any injection control-token pattern matches. */
export function containsInjection(body: string): boolean {
    return scanForInjection(body).length > 0;
}

/**
 * Hard-reject helper for the import path: throws a precise, actionable
 * error when an imported instruction body carries chat-template control
 * tokens, without echoing the full body back.
 */
export function assertNoInjectionTokens(body: string, fieldHint = 'imported content'): void {
    const hits = scanForInjection(body);
    if (hits.length === 0) return;
    const first = hits[0];
    throw new Error(
        `Disallowed chat-template control token (${first.pattern}: "${first.matched}") detected in ${fieldHint}. ` +
            `Imported Agent/Skill instructions must not contain model control sequences (e.g. <|im_start|>, [INST]) — ` +
            `they can hijack the agent's system prompt. Remove them before importing.`,
    );
}

function truncateForDisplay(s: string): string {
    if (s.length <= 24) return s;
    return `${s.slice(0, 12)}…${s.slice(-6)}`;
}
