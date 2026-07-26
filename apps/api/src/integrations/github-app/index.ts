export * from './github-app.module';
export * from './github-app.service';
export * from './github-app-onboarding.service';
export * from './github-app-sync.service';
export * from './github-app.controller';
// `GitHubAppWebhookController` is NOT re-exported here any more: when the
// two GitHub webhook receivers were consolidated into one dispatcher the
// class moved to `ingest/github/github-app-webhook.controller.ts`, next
// to the receiver it forwards to. The route
// (`POST /api/github-app/webhooks`) is unchanged; re-exporting it from
// this barrel would close an import cycle back into `ingest/`, which is
// exactly what the move avoids.
export * from './dto/github-app.dto';
