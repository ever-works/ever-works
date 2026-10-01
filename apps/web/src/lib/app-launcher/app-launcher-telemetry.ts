import posthog from 'posthog-js';

/**
 * APW-11 T14 — the App Launcher's four analytics events (plan §9.1).
 *
 * Every property is an identifier, an enum, a count or a boolean. There is no
 * field for a host, a URL, a Work name or a Work id anywhere in the union, which
 * is the point: a launcher tile carries all four, so the only way to guarantee
 * they cannot be sent is to make them **unrepresentable** rather than to
 * remember not to add them.
 *
 * `catalog_id` is the exception that looks like one of those and is not: it is a
 * **catalog** identifier (`cal-diy`), a public entry in a list every member can
 * read, not a tenant identifier. `position` is the tile's index in the rendered
 * grid, `pinned` is the arrangement — both are the operator's own arrangement
 * numbers, never content.
 *
 * The union is closed, so adding a free-text property is a compile error here
 * rather than a review question (ACC-11-32).
 */

/** Where the element was opened from. */
export type AppLauncherOpenSource = 'header' | 'palette';

/**
 * What an opened tile was. `work` and `platform` are the two kinds the list
 * carries; `manage` is the Manage-apps row, which is a tile in the panel but not
 * an item in the registry.
 */
export type AppLauncherItemKind = 'work' | 'platform' | 'manage';

/** The exposure toggle's new value, as the settings surface reports it. */
export type AppLauncherExposureDirection = 'on' | 'off' | 'default';

export type AppLauncherTelemetryEvent =
    | {
          name: 'app_launcher_opened';
          properties: {
              pinned: number;
              platforms: number;
              works: number;
              source: AppLauncherOpenSource;
          };
      }
    | {
          name: 'app_launcher_item_opened';
          properties: {
              item_kind: AppLauncherItemKind;
              /** The catalog entry's public id. Never a Work id and never a URL. */
              catalog_id?: string;
              position: number;
              pinned: boolean;
          };
      }
    | {
          name: 'app_launcher_preferences_saved';
          properties: { changes: number; pinned_total: number };
      }
    | {
          name: 'app_launcher_exposure_changed';
          properties: { direction: AppLauncherExposureDirection; work_kind: string };
      };

/**
 * Capture one App Launcher event through the already-mounted analytics client.
 *
 * Same contract as `captureHelpEvent` (`lib/help/help-telemetry.ts`): silent
 * when analytics is not configured, and it **never throws** — telemetry must not
 * be able to break opening an app, and the caller is a click handler.
 */
export function captureAppLauncherEvent(event: AppLauncherTelemetryEvent): void {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
    try {
        posthog.capture(event.name, event.properties);
    } catch {
        // Analytics must never break the launcher.
    }
}
