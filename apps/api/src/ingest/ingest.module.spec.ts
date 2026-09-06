/**
 * `IngestModule` — module-shape pin for the GitHub receiver
 * consolidation (audit 08(g)).
 *
 * What this guards: the platform ran TWO GitHub webhook receivers, and
 * the merge is only real if BOTH routes are registered by THIS module
 * over the ONE shared dispatcher, and if the App module no longer
 * registers a webhook controller of its own. A second registration of
 * `POST /api/github-app/webhooks` would silently shadow the forwarder
 * (Nest keeps the first match), quietly restoring the split — invisible
 * to `tsc`, invisible to every controller unit test, and invisible to
 * `generate:openapi`, which runs Nest in PREVIEW mode.
 *
 * Mocking posture mirrors `agents/agents.module.spec.ts`: stub the heavy
 * workspace barrels at module scope so decorator metadata can be read
 * without dragging the entity/zod graph through Jest's CJS transformer.
 */

jest.mock('@ever-works/agent/database', () => ({
    DatabaseModule: class DatabaseModule {},
    GitHubAppInstallationRepository: class GitHubAppInstallationRepository {},
    GitHubAppUserLinkRepository: class GitHubAppUserLinkRepository {},
    // Issue + incident intake (§6): the triage filer's Work lookup.
    WorkRepository: class WorkRepository {},
}));
jest.mock('@ever-works/agent/ingest', () => ({
    EventIngestModule: class EventIngestModule {},
    EventIngestService: class EventIngestService {},
    IngestedEventRepository: class IngestedEventRepository {},
    IngestInstallBindingRepository: class IngestInstallBindingRepository {},
    // Issue + incident intake (§6): the triage filer's link lookups.
    ExternalIssueLinkService: class ExternalIssueLinkService {},
}));
jest.mock('@ever-works/agent/utils', () => ({
    redactSecrets: (body: string) => ({ cleaned: body, redactions: 0 }),
}));
jest.mock('@ever-works/agent/pr-review', () => ({
    PrReviewModule: class PrReviewModule {},
    PrReviewService: class PrReviewService {},
}));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginSettingsService: class PluginSettingsService {},
    UserPluginRepository: class UserPluginRepository {},
}));
jest.mock('../ai-conversation/ai-conversation.module', () => ({
    AiConversationModule: class AiConversationModule {},
}));
jest.mock('../ai-conversation/openai-compat.service', () => ({
    OpenAiCompatService: class OpenAiCompatService {},
}));
jest.mock('../integrations/github-app/github-app.module', () => ({
    GitHubAppModule: class GitHubAppModule {},
}));
jest.mock('../integrations/github-app/github-app-sync.service', () => ({
    GitHubAppSyncService: class GitHubAppSyncService {},
}));

import { IngestModule } from './ingest.module';
import { IngestController } from './ingest.controller';
import { SlackEventsController } from './slack/slack-events.controller';
import { SlackCommandsController } from './slack/slack-commands.controller';
import { GitHubEventsController } from './github/github-events.controller';
import { GitHubAppWebhookController } from './github/github-app-webhook.controller';
import { GitHubPrReviewBridgeService } from './github/github-pr-review-bridge.service';
import { GitHubWebhookDispatcherService } from './github/github-webhook-dispatcher.service';
import { SlackChatBridgeService } from './slack/slack-chat-bridge.service';
import { GitHubAppModule } from '../integrations/github-app/github-app.module';
import { GitHubIssueIntakeService } from './github/github-issue-intake.service';
import { DependabotIncidentSource } from './incidents/dependabot-incident.source';
import { JiraEventsController } from './jira/jira-events.controller';
import { JiraIssueBridgeService } from './jira/jira-issue-bridge.service';
import { SentryBindingsController } from './sentry/sentry-bindings.controller';
import { SentryIncidentSource } from './sentry/sentry-incident.source';
import { SentryInstallBindingService } from './sentry/sentry-install-binding.service';
import { SentryWebhookController } from './sentry/sentry-webhook.controller';
import { TriageTaskFilerService } from './triage/triage-task-filer.service';
import { EventIngestService } from '@ever-works/agent/ingest';

const controllers = () => Reflect.getMetadata('controllers', IngestModule) ?? [];
const providers = () => Reflect.getMetadata('providers', IngestModule) ?? [];
const imports = () => Reflect.getMetadata('imports', IngestModule) ?? [];

describe('IngestModule (consolidated GitHub receiver wiring)', () => {
    it('registers BOTH GitHub routes over the one shared dispatcher', () => {
        expect(controllers()).toEqual(
            expect.arrayContaining([
                IngestController,
                SlackEventsController,
                GitHubEventsController,
                GitHubAppWebhookController,
            ]),
        );
    });

    /**
     * Same shape-guard for Slack: the slash command is a SECOND route on
     * the ONE bridge. If the controller stops being registered here the
     * route silently 404s (Slack shows the user `dispatch_failed`), and
     * if it were given its own service the two entry points would drift
     * apart — both invisible to `tsc` and to the controller unit tests.
     */
    it('registers the Slack slash-command route over the same chat bridge', () => {
        expect(controllers()).toEqual(expect.arrayContaining([SlackCommandsController]));

        const injected = Reflect.getMetadata(
            'design:paramtypes',
            SlackCommandsController,
        ) as unknown[];
        expect(injected).toEqual([SlackChatBridgeService]);

        // …and the events receiver still depends on the very same one.
        expect(Reflect.getMetadata('design:paramtypes', SlackEventsController)).toEqual([
            SlackChatBridgeService,
        ]);

        // Exactly one bridge instance backs both routes.
        expect(providers().filter((p: unknown) => p === SlackChatBridgeService)).toHaveLength(1);
    });

    it('provides the single dispatcher and the PR-review bridge exactly once', () => {
        const provided = providers();
        expect(provided).toEqual(
            expect.arrayContaining([
                SlackChatBridgeService,
                GitHubPrReviewBridgeService,
                GitHubWebhookDispatcherService,
            ]),
        );
        expect(provided.filter((p: unknown) => p === GitHubWebhookDispatcherService)).toHaveLength(
            1,
        );
        expect(provided.filter((p: unknown) => p === GitHubPrReviewBridgeService)).toHaveLength(1);
    });

    it('imports GitHubAppModule — the fan-out to the App sync consumer', () => {
        expect(imports()).toEqual(expect.arrayContaining([GitHubAppModule]));
    });

    it('injects both consumers plus the App installation lookups into the dispatcher', () => {
        const injected = Reflect.getMetadata(
            'design:paramtypes',
            GitHubWebhookDispatcherService,
        ) as unknown[];
        expect(injected).toHaveLength(4);
        expect(injected[0]).toBe(GitHubPrReviewBridgeService);
    });

    it('leaves the two receiver controllers with the dispatcher as their ONLY dependency', () => {
        for (const controller of [GitHubEventsController, GitHubAppWebhookController]) {
            const injected = Reflect.getMetadata('design:paramtypes', controller) as unknown[];
            expect(injected).toEqual([GitHubWebhookDispatcherService]);
        }
    });
});

/**
 * Issue + incident intake (self-build program note §6, R2/R23) — the
 * same shape-guard for the three new receivers and the triage filer. A
 * receiver that drops out of this module silently 404s (the vendor sees
 * a failed delivery and nothing is filed); a provider registered twice
 * would register its consumer / kind processor twice.
 */
describe('IngestModule (issue + incident intake wiring)', () => {
    it('registers the Jira receiver and both Sentry routes exactly once', () => {
        const registered = controllers();
        for (const controller of [
            JiraEventsController,
            SentryWebhookController,
            SentryBindingsController,
        ]) {
            expect(registered.filter((c: unknown) => c === controller)).toHaveLength(1);
        }
    });

    it('provides the intake services and the triage filer exactly once each', () => {
        const provided = providers();
        for (const provider of [
            GitHubIssueIntakeService,
            DependabotIncidentSource,
            JiraIssueBridgeService,
            SentryIncidentSource,
            SentryInstallBindingService,
            TriageTaskFilerService,
        ]) {
            expect(provided.filter((p: unknown) => p === provider)).toHaveLength(1);
        }
    });

    it('feeds the GitHub issue intake from the ONE dispatcher (a registered consumer, not a new receiver)', () => {
        const injected = Reflect.getMetadata(
            'design:paramtypes',
            GitHubIssueIntakeService,
        ) as unknown[];
        expect(injected[0]).toBe(GitHubWebhookDispatcherService);
        expect(injected).toContain(DependabotIncidentSource);
        // …and the dispatcher itself did NOT grow a constructor dependency
        // on it (the arity pin above stays at 4).
        expect(
            Reflect.getMetadata('design:paramtypes', GitHubWebhookDispatcherService),
        ).toHaveLength(4);
    });

    it('gives the Sentry receiver exactly the source, the claim-backed bindings and the spine', () => {
        expect(Reflect.getMetadata('design:paramtypes', SentryWebhookController)).toEqual([
            SentryIncidentSource,
            SentryInstallBindingService,
            EventIngestService,
        ]);
        // The claim endpoint writes owners; the receiver only reads them.
        expect(Reflect.getMetadata('design:paramtypes', SentryBindingsController)).toEqual([
            SentryInstallBindingService,
        ]);
    });

    it('keeps the Jira receiver a thin shell over its bridge', () => {
        expect(Reflect.getMetadata('design:paramtypes', JiraEventsController)).toEqual([
            JiraIssueBridgeService,
        ]);
    });
});

describe('GitHubAppModule (no second GitHub webhook receiver)', () => {
    it('no longer registers a webhook controller of its own', () => {
        // Loaded unmocked, on purpose: this is the assertion that the
        // split is really gone.
        jest.isolateModules(() => {
            jest.unmock('../integrations/github-app/github-app.module');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const source = require('node:fs').readFileSync(
                require('node:path').join(
                    __dirname,
                    '../integrations/github-app/github-app.module.ts',
                ),
                'utf8',
            ) as string;
            expect(source).not.toMatch(/GitHubAppWebhookController/);
            expect(source).toMatch(/controllers:\s*\[GitHubAppController\]/);
        });
    });
});
