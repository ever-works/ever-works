import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Trusted reviewer-bot COMMENT bodies, verbatim, as this repository's own
 * pull requests received them — the corpus `classifyReviewBotComment` is
 * pinned against (`review-bot-comments.json`, next to this file).
 *
 * Every body was read with `gh api` (issue comments) or GraphQL
 * `userContentEdits` (the FIRST revision of a comment the bot later
 * edited — the only way to recover CodeRabbit's "review in progress"
 * placeholder, which is the body production recorded as a rejection on
 * ever-works/ever-works#2575). `source` names where each one came from.
 * One edit was made: CodeRabbit's change-stack links carry a
 * `scope=ghh_…` grant, replaced with `scope=REDACTED`; it is not
 * load-bearing for any rule.
 *
 * `expected` is `findings` or `ignore:<reason>`.
 *
 * A `.helper-spec.ts` file: excluded from the build by `tsconfig.build`'s
 * `*spec.ts` pattern and never collected by Jest (whose `testRegex` wants
 * `.spec.ts`), like the instance-stats fixture helpers.
 */
export interface ReviewBotCommentFixture {
    readonly name: string;
    /** The webhook event the comment arrives on. */
    readonly event: 'issue_comment' | 'pull_request_review_comment';
    readonly expected: string;
    readonly source: string;
    readonly author: string;
    readonly body: string;
}

let cache: readonly ReviewBotCommentFixture[] | null = null;

export function reviewBotCommentFixtures(): readonly ReviewBotCommentFixture[] {
    if (!cache) {
        cache = JSON.parse(
            readFileSync(join(__dirname, 'review-bot-comments.json'), 'utf8'),
        ) as ReviewBotCommentFixture[];
    }
    return cache;
}

/** One fixture by name; throws on a typo so a spec cannot pass vacuously. */
export function reviewBotCommentFixture(name: string): ReviewBotCommentFixture {
    const found = reviewBotCommentFixtures().find((fixture) => fixture.name === name);
    if (!found) throw new Error(`No review-bot comment fixture named '${name}'.`);
    return found;
}
