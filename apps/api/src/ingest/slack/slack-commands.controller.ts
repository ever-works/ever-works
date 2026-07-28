import {
    BadRequestException,
    Controller,
    Headers,
    HttpCode,
    HttpStatus,
    Logger,
    Post,
    Req,
    UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../auth/decorators/public.decorator';
import {
    SlackChatBridgeService,
    extractSlackWorkspaceRef,
    type SlackSlashCommandBody,
} from './slack-chat-bridge.service';
import { verifySlackSignature } from './slack-signature.util';

/**
 * Slack's hard ack budget for a slash command: the invoking user sees an
 * `operation_timeout` error if the HTTP response has not arrived within
 * this window. Everything the receiver does before responding must stay
 * comfortably inside it — the actual answer is produced detached.
 */
export const SLACK_COMMAND_ACK_BUDGET_MS = 3000;

/** Shown the instant the command is accepted, before the answer exists. */
export const SLACK_COMMAND_ACK_TEXT =
    'On it — I am asking Ever Works now and will post the answer in this channel shortly.';

/** Shown when a signed command arrives from a workspace nothing is bound to. */
export const SLACK_COMMAND_NOT_CONNECTED_TEXT =
    'This Slack workspace is not connected to an Ever Works account yet. Enable the Slack connector in Ever Works and try again.';

/** Slash-command names are `/` + up to 32 word characters (Slack's own rule). */
const SLACK_COMMAND_NAME_PATTERN = /^\/[\w-]{1,32}$/;

/** Fallback shown in the usage hint when the payload names no valid command. */
const SLACK_DEFAULT_COMMAND_NAME = '/works';

/** Usage hint for an invocation with no text after the command. */
export function slackCommandUsageText(command: string | undefined): string {
    const name =
        typeof command === 'string' && SLACK_COMMAND_NAME_PATTERN.test(command.trim())
            ? command.trim()
            : SLACK_DEFAULT_COMMAND_NAME;
    return `Usage: \`${name} <your question>\` — for example \`${name} what shipped today?\``;
}

/**
 * The immediate response body Slack renders for the invoking user.
 * `ephemeral` keeps the ack private; the answer itself is posted into
 * the channel afterwards, so the ack is not duplicated for everyone.
 */
export interface SlackCommandAck {
    readonly response_type: 'ephemeral';
    readonly text: string;
}

/**
 * Slack slash-command receiver — the platform-side endpoint the Ever
 * Works Slack app points a slash command (`/works …`) at.
 *
 * ## Why it is a second controller, not a branch in the events receiver
 *
 * Slash commands are a DIFFERENT Slack contract from the Events API:
 * they arrive `application/x-www-form-urlencoded` (not JSON), they carry
 * no `type`/`event` envelope, they have no `url_verification` handshake,
 * and — the load-bearing difference — the HTTP response body is USER
 * VISIBLE and must arrive within
 * {@link SLACK_COMMAND_ACK_BUDGET_MS}. Keeping them apart leaves the
 * events receiver untouched while both share the security and routing
 * machinery below.
 *
 * ## What is shared (deliberately, all of it)
 *
 * * **Signature verification** — the SAME `verifySlackSignature` helper
 *   (HMAC v0 over `v0:{ts}:{rawBody}`, ±300s tolerance, constant-time
 *   compare) over the raw body captured by the `bodyParser` `verify`
 *   hook in `main.ts` (registered for `urlencoded` too, which is what a
 *   slash command is). No second, ad-hoc verifier exists.
 * * **Per-workspace resolution** — the SAME
 *   `SlackChatBridgeService.resolveBinding()`: the delivery's `team_id`
 *   (plus `enterprise_id` on Grid) selects the owning install, so two
 *   customers' workspaces never cross-attribute. Fail-closed: nothing
 *   configured at all → 401; an unknown workspace is refused as a clean,
 *   user-visible no-op rather than guessed.
 * * **The chat leg** — `handleSlashCommand()` runs the very same
 *   completion + reply path an `@works` mention takes, so a command and
 *   a mention answer identically.
 *
 * ## Ack-then-work
 *
 * Verification, workspace resolution and the binding write happen before
 * responding (all bounded, no model call). The chat completion is then
 * DETACHED — deliberately not awaited — and the receiver returns its
 * ephemeral ack immediately. The answer is posted into the channel by
 * the bridge when it is ready.
 *
 * Slack also offers `response_url` for that delayed message. We reply
 * through the slack-connector plugin instead: it is the one audited
 * Slack egress path (bot token, `@slack/web-api`, host-pinned), it keeps
 * command and mention replies byte-for-byte consistent, and it avoids
 * making the API POST to a URL taken off a request body.
 */
@ApiTags('ingest')
@Controller('api/ingest')
export class SlackCommandsController {
    private readonly logger = new Logger(SlackCommandsController.name);

    constructor(private readonly slackChatBridge: SlackChatBridgeService) {}

    @Public()
    @Post('slack/commands')
    @ApiOperation({
        summary:
            'Slack slash-command receiver — signature-verified; immediate ephemeral ack, then the platform-chat answer is posted into the channel.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 300, ttl: 60_000 } })
    async receiveCommand(
        @Req() req: { body: unknown; rawBody?: string },
        @Headers('x-slack-signature') signature: string | undefined,
        @Headers('x-slack-request-timestamp') timestamp: string | undefined,
    ): Promise<SlackCommandAck> {
        if (!req.rawBody) {
            throw new BadRequestException('Missing raw request payload');
        }

        const rawBody = req.rawBody;
        const command = (req.body ?? {}) as SlackSlashCommandBody;

        // Resolve WHICH install owns this workspace before verifying, so
        // the right signing secret is used. The workspace ref comes from
        // the unverified body and only selects a candidate secret — a
        // forged team_id picks a secret that fails the HMAC below.
        const resolution = await this.slackChatBridge.resolveBinding({
            workspace: extractSlackWorkspaceRef(command),
            verifySignature: (signingSecret) =>
                verifySlackSignature({ rawBody, timestamp, signature, signingSecret }).valid,
        });

        // Fail-closed: nothing configured → reject.
        if (resolution.status === 'not-configured') {
            throw new UnauthorizedException('Slack command receiver is not configured');
        }
        // Unknown/ambiguous workspace → clean no-op. The bridge already
        // logged the refusal; 200 with an ephemeral explanation so the
        // person who typed the command is not left staring at a timeout.
        if (resolution.status === 'unresolved') {
            return { response_type: 'ephemeral', text: SLACK_COMMAND_NOT_CONNECTED_TEXT };
        }

        const binding = resolution.binding;

        const verdict = verifySlackSignature({
            rawBody,
            timestamp,
            signature,
            signingSecret: binding.signingSecret,
        });
        if (!verdict.valid) {
            throw new UnauthorizedException('Invalid Slack request signature');
        }

        // Verified — persist the workspace→user binding so subsequent
        // deliveries resolve exactly instead of through the fallback.
        await this.slackChatBridge.recordBinding(binding);

        // `/works` with nothing after it: answer with the usage hint
        // rather than sending an empty prompt to the chat engine.
        if (!(command.text ?? '').trim()) {
            return { response_type: 'ephemeral', text: slackCommandUsageText(command.command) };
        }

        // DETACHED on purpose — a model call cannot fit in Slack's ack
        // budget. `Promise.resolve().then(...)` also contains a
        // synchronous throw, so nothing can escape into the response path.
        void Promise.resolve()
            .then(() => this.slackChatBridge.handleSlashCommand(binding, command))
            .catch((error: unknown) => {
                // handleSlashCommand is best-effort internally; this is a
                // belt-and-suspenders guard against an unhandled rejection.
                this.logger.warn(
                    `Slack slash-command handling failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            });

        return { response_type: 'ephemeral', text: SLACK_COMMAND_ACK_TEXT };
    }
}
