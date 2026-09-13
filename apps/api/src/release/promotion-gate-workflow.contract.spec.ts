import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROMOTION_GATE_OVERRIDE_LABEL, PROMOTION_GATE_WORKFLOW_FILE } from '@ever-works/contracts';

/**
 * Release promotion lane (self-build slice AI, EW-808) — the contract
 * between the platform and the workflow it waits on.
 *
 * `ReleasePromotionService` reads ONE named workflow file for the head
 * commit of a promotion pull request. Two things about that file are not
 * the platform's to change silently, and neither is visible to `tsc`:
 *
 *   1. **The file name.** `PROMOTION_GATE_WORKFLOW_FILE` is what the
 *      platform asks GitHub for. Rename the workflow and every promotion
 *      reads `absent` — which is correctly not-a-pass, but silently means
 *      no promotion can ever advance again.
 *   2. **The trigger.** Before this slice the workflow ran only on pull
 *      requests into `main`, so the `develop → stage` rung had no verdict
 *      to read at all and the lane could not advance past the first step.
 *
 * The `if:` condition on `e2e-result` is pinned too, but as a REMINDER
 * rather than a requirement: that job skips on a `develop → stage`
 * promotion, and a skipped job reports as SUCCESS in branch protection.
 * The lane reads the WORKFLOW RUN's conclusion for exactly that reason,
 * and `node-contract` — which has no `if:` — is what makes the run's
 * conclusion mean something on the first rung.
 */
describe('promotion-gate.yml — the workflow the release lane waits on', () => {
    const path = join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        '.github',
        'workflows',
        PROMOTION_GATE_WORKFLOW_FILE,
    );
    const source = readFileSync(path, 'utf8');

    it('exists at the file name the platform asks the provider for', () => {
        expect(PROMOTION_GATE_WORKFLOW_FILE).toBe('promotion-gate.yml');
        expect(source).toContain('name: Promotion Gate');
    });

    it('runs on BOTH rungs of the ladder', () => {
        // `branches: [main]` alone is what made the develop -> stage rung
        // vacuous: no run for the commit, so `absent`, so never a pass.
        const trigger = source.slice(source.indexOf('on:'), source.indexOf('permissions:'));
        expect(trigger).toMatch(/branches:\s*\[main,\s*stage\]/);
        expect(trigger).toMatch(/pull_request:/);
    });

    it('keeps a job that runs on EVERY promotion, so a run conclusion means something', () => {
        // If every job could skip, the run itself would conclude `skipped`
        // and the lane would refuse every promotion forever.
        const nodeContract = source.slice(source.indexOf('  node-contract:'));
        const firstJobBody = nodeContract.slice(0, nodeContract.indexOf('    steps:'));
        expect(firstJobBody).not.toMatch(/^\s{4}if:/m);
    });

    it('still gates the stage E2E result on a stage head only', () => {
        // Kept deliberately: `develop -> stage` has no e2e signal to
        // consult (e2e.yml runs on push to `develop` only), so a green
        // gate on the FIRST rung means the node contract held and nothing
        // more. The runbook says so in the same words.
        expect(source).toMatch(/if:\s*github\.event\.pull_request\.head\.ref == 'stage'/);
    });

    it('keeps the override an explicit, attributable label rather than a default', () => {
        expect(source).toContain(PROMOTION_GATE_OVERRIDE_LABEL);
        // The workflow reads the label off the pull request; the shared
        // constant is the platform's copy of the SAME string. The two must
        // agree byte-for-byte, so the label is spelled once in contracts
        // and referenced from both sides.
        expect(PROMOTION_GATE_OVERRIDE_LABEL).toBe('override-e2e-gate');
    });

    it('is read by the lane as a WARNING, never as a grant', () => {
        // CONTRACT REVERSED, deliberately, and this comment is the record
        // of why. This test used to assert the lane's source did not
        // mention the override at all — "the lane must not encode it".
        // That was the wrong shape of the right idea, and it hid a real
        // defect: the workflow exits 0 on the label in all four of its
        // failure branches, GitHub folds that into a plain `success` run
        // conclusion, and the lane then told the person deciding a
        // production release "Promotion gate PASSED" when what actually
        // happened is that somebody with repository write applied a label.
        //
        // The property that is actually wanted is narrower: the label may
        // never GRANT anything, and it must be reported. So the lane now
        // reads it and words the notice accordingly, and what is pinned
        // here is that it is spelled through the shared constant (never a
        // second copy of the literal, which could drift from the workflow)
        // and that the pass rule is still `isPromotionGatePass` alone.
        const laneSource = readFileSync(
            join(
                __dirname,
                '..',
                '..',
                '..',
                '..',
                'packages',
                'agent',
                'src',
                'tasks-domain',
                'release-promotion.service.ts',
            ),
            'utf8',
        );
        // No second copy of the literal — one spelling, in contracts.
        // Comments are stripped first: prose is allowed to NAME the label
        // (and does, next to the explanation of why it is read at all);
        // what must not exist is a second string constant that could drift
        // from the workflow's own spelling.
        const code = laneSource
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n')
            .filter((line) => !line.trim().startsWith('//'))
            .join('\n');
        expect(code).not.toMatch(/['"`]override-e2e-gate['"`]/);
        expect(code).toContain('PROMOTION_GATE_OVERRIDE_LABEL');
        // And it is not part of any decision: the only thing that makes a
        // verdict a pass is `isPromotionGatePass`, and an overridden
        // reading is fed to the same rule as any other.
        expect(code).not.toMatch(/isPromotionGateOverridden\([^)]*\)\s*(\?|&&|\|\|)/);
    });
});
