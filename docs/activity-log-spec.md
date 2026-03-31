# Activity Log — Implementation Spec

## Overview

A global activity log that tracks all significant operations across the Ever Works platform. Users access it from a dedicated sidebar menu item, where they can see a real-time feed of everything happening across all their directories and account-level actions.

This is separate from the existing **Directory History tab** (which provides detailed per-directory execution traces with step logs, changelogs, and metrics). The Activity Log is a higher-level, cross-directory feed that answers: "What has happened across my account?"

---

## Requirements

1. Dedicated Activity page accessible from sidebar navigation
2. Table with columns: DateTime, Directory, Action Type, Details
3. `activity_log` DB table with JSON details column, directory reference, and enum action type
4. Call a logging method from every significant operation in the platform
5. Activity Log page pulls from the API/DB table
6. Simultaneously send events to [Jitsu](https://jitsu.com/) analytics
7. Capture as much activity as possible
8. Real-time feed — new activities appear without page refresh
9. Filters by activity type, directory, status, date range
10. Search across activity descriptions and directory names
11. Clickable entries open detail view with full logs, items affected, duration, errors
12. Badge on sidebar icon showing count of currently running operations
13. Bulk actions: dismiss, retry failed, export activity log

---

## Database Schema

### Table: `activity_log`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | UUID (PK) | No | Primary key |
| `userId` | UUID (FK → users) | No | Who performed the action |
| `directoryId` | UUID (FK → directories) | Yes | Which directory (null for account-level actions) |
| `actionType` | varchar/enum | No | Category of action (see enum below) |
| `action` | varchar | No | Specific action identifier (e.g. `items.generated`, `plugin.enabled`) |
| `status` | varchar/enum | No | `pending`, `in_progress`, `completed`, `failed` |
| `summary` | varchar | No | Human-readable summary (e.g. "Generated 24 items for Tech Startups") |
| `details` | JSON | Yes | Structured data — items affected, parameters, error messages, duration, linked history ID |
| `metadata` | JSON | Yes | Extra data for analytics/Jitsu |
| `ipAddress` | varchar | Yes | Request IP address |
| `userAgent` | varchar | Yes | Request user agent |
| `createdAt` | timestamp | No | When the activity was logged |
| `updatedAt` | timestamp | No | Last update (for status transitions: pending → completed) |

### Indexes

- `(userId, createdAt DESC)` — main query path (user's activity feed)
- `(userId, actionType)` — filter by type
- `(userId, directoryId)` — filter by directory
- `(userId, status)` — filter by status, count running operations for badge

---

## Action Types

```typescript
enum ActivityActionType {
    // Generation
    GENERATION = 'generation',
    COMPARISON_GENERATION = 'comparison_generation',

    // Deployment
    DEPLOYMENT = 'deployment',

    // Directory lifecycle
    DIRECTORY_CREATED = 'directory_created',
    DIRECTORY_UPDATED = 'directory_updated',
    DIRECTORY_DELETED = 'directory_deleted',

    // Items
    ITEM_ADDED = 'item_added',
    ITEM_UPDATED = 'item_updated',
    ITEM_REMOVED = 'item_removed',

    // Plugins
    PLUGIN_ENABLED = 'plugin_enabled',
    PLUGIN_DISABLED = 'plugin_disabled',
    PLUGIN_CONFIGURED = 'plugin_configured',

    // Members
    MEMBER_INVITED = 'member_invited',
    MEMBER_ROLE_CHANGED = 'member_role_changed',
    MEMBER_REMOVED = 'member_removed',

    // Schedule
    SCHEDULE_CREATED = 'schedule_created',
    SCHEDULE_UPDATED = 'schedule_updated',
    SCHEDULE_DELETED = 'schedule_deleted',
    SCHEDULE_EXECUTED = 'schedule_executed',

    // Import / Export
    IMPORT = 'import',
    EXPORT = 'export',

    // Settings
    SETTINGS_UPDATED = 'settings_updated',
    WEBSITE_SETTINGS_UPDATED = 'website_settings_updated',
    PROMPTS_UPDATED = 'prompts_updated',

    // Auth / Account
    USER_LOGIN = 'user_login',
    USER_SIGNUP = 'user_signup',
    PROVIDER_CONNECTED = 'provider_connected',
    PASSWORD_CHANGED = 'password_changed',

    // Chat / AI
    CHAT_CONVERSATION = 'chat_conversation',

    // Community
    COMMUNITY_PR_MERGED = 'community_pr_merged',
}
```

### Activity Status

```typescript
enum ActivityStatus {
    PENDING = 'pending',
    IN_PROGRESS = 'in_progress',
    COMPLETED = 'completed',
    FAILED = 'failed',
}
```

---

## Backend Architecture

### New module: `activity-log`

```
packages/agent/src/
├── entities/
│   └── activity-log.entity.ts              # TypeORM entity
├── database/repositories/
│   └── activity-log.repository.ts          # Query methods
├── activity-log/
│   └── activity-log.service.ts             # Core log() method + Jitsu dispatch

apps/api/src/
├── activity-log/
│   ├── activity-log.module.ts              # NestJS module
│   ├── activity-log.controller.ts          # REST API endpoints
│   ├── activity-log.gateway.ts             # WebSocket gateway for real-time
│   └── dto/
│       ├── activity-log-query.dto.ts       # Query/filter params
│       └── activity-log-response.dto.ts    # Response shape
```

### ActivityLogService — Core API

```typescript
class ActivityLogService {
    /**
     * Log an activity. Writes to DB and dispatches to Jitsu.
     * This is the single entry point called from all integration points.
     */
    async log(entry: {
        userId: string;
        directoryId?: string;
        actionType: ActivityActionType;
        action: string;
        status: ActivityStatus;
        summary: string;
        details?: Record<string, any>;
        metadata?: Record<string, any>;
        ipAddress?: string;
        userAgent?: string;
    }): Promise<ActivityLog>;

    /**
     * Update an existing activity's status (e.g. pending → completed).
     * Also dispatches the status change to Jitsu.
     */
    async updateStatus(
        id: string,
        status: ActivityStatus,
        details?: Record<string, any>,
    ): Promise<ActivityLog>;

    /**
     * Query activities with filtering, pagination, and search.
     */
    async findAll(query: {
        userId: string;
        actionType?: ActivityActionType;
        directoryId?: string;
        status?: ActivityStatus;
        dateFrom?: Date;
        dateTo?: Date;
        search?: string;
        limit?: number;
        offset?: number;
    }): Promise<{ activities: ActivityLog[]; total: number }>;

    /**
     * Count currently running operations for sidebar badge.
     */
    async countRunning(userId: string): Promise<number>;

    /**
     * Get a single activity with full details.
     */
    async findById(id: string): Promise<ActivityLog | null>;
}
```

### REST API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/activity-log` | List activities (paginated, filtered, searchable) |
| `GET` | `/api/activity-log/running-count` | Count of in_progress activities (for badge) |
| `GET` | `/api/activity-log/:id` | Get single activity with full details |
| `POST` | `/api/activity-log/:id/retry` | Retry a failed activity (re-triggers the original operation) |
| `DELETE` | `/api/activity-log/:id` | Dismiss/delete an activity entry |
| `GET` | `/api/activity-log/export` | Export activity log as CSV |

### Query Parameters (GET /api/activity-log)

| Param | Type | Description |
|-------|------|-------------|
| `actionType` | string | Filter by action type |
| `directoryId` | string | Filter by directory |
| `status` | string | Filter by status |
| `dateFrom` | ISO string | Start of date range |
| `dateTo` | ISO string | End of date range |
| `search` | string | Search summary and directory name |
| `limit` | number | Page size (default 25, max 100) |
| `offset` | number | Pagination offset |

### Integration Points — Where to Call `activityLogService.log()`

Activities will be logged by **subscribing to existing events** where possible, and by **adding direct calls** where events don't exist yet.

#### Via EventEmitter2 listeners (existing events)

| Event | Action Type | Summary Example |
|-------|-------------|-----------------|
| `DirectoryCreatedEvent` | `directory_created` | "Created directory: Tech Startups" |
| `DirectoryGenerationCompletedEvent` | `generation` | "Generated 24 items for Tech Startups" |
| `UserCreatedEvent` | `user_signup` | "Account created" |
| `UserConfirmedEvent` | `user_login` | "Signed in via GitHub" |
| `UserPasswordChangedEvent` | `password_changed` | "Password changed" |
| `MemberInvitedEvent` | `member_invited` | "Invited user@email.com as Editor to Tech Startups" |

#### Via direct calls (no existing events — add `activityLogService.log()` calls)

| Location | Action Type | Summary Example |
|----------|-------------|-----------------|
| `deploy.service.ts` → deploy method | `deployment` | "Deployed Tech Startups to Vercel" |
| `deploy.service.ts` → batch deploy | `deployment` | "Batch deployed 3 directories" |
| `plugin-operations.service.ts` → enable | `plugin_enabled` | "Enabled OpenAI plugin" |
| `plugin-operations.service.ts` → disable | `plugin_disabled` | "Disabled Tavily plugin" |
| `plugins.controller.ts` → update settings | `plugin_configured` | "Updated OpenAI plugin settings" |
| `directory-lifecycle.service.ts` → update | `directory_updated` | "Updated directory: Tech Startups" |
| `directory-lifecycle.service.ts` → delete | `directory_deleted` | "Deleted directory: Tech Startups" |
| `directory-schedule.service.ts` → create | `schedule_created` | "Created weekly schedule for Tech Startups" |
| `directory-schedule.service.ts` → update | `schedule_updated` | "Updated schedule for Tech Startups" |
| `directory-schedule.service.ts` → delete | `schedule_deleted` | "Deleted schedule for Tech Startups" |
| `directory-schedule.service.ts` → execute | `schedule_executed` | "Scheduled update started for Tech Startups" |
| `comparison-generation.service.ts` → generate | `comparison_generation` | "Generated comparison: Tool A vs Tool B" |
| `directory-import.service.ts` → import | `import` | "Imported directory from GitHub repo" |
| `members.controller.ts` → update role | `member_role_changed` | "Changed user@email.com role to Manager" |
| `members.controller.ts` → remove | `member_removed` | "Removed user@email.com from Tech Startups" |
| `directories.controller.ts` → update website settings | `website_settings_updated` | "Updated website settings for Tech Startups" |
| `directories.controller.ts` → update advanced prompts | `prompts_updated` | "Updated prompts for Tech Startups" |
| `openai-compat.service.ts` → new conversation | `chat_conversation` | "Started AI conversation" |
| `community-pr-processor.service.ts` → merged | `community_pr_merged` | "Merged community PR for Tech Startups" |

### Jitsu Integration

```typescript
// In ActivityLogService.log():
async log(entry: CreateActivityDto): Promise<ActivityLog> {
    // 1. Write to database (guaranteed)
    const activity = await this.activityLogRepository.create(entry);

    // 2. Dispatch to Jitsu (fire-and-forget, don't block on failure)
    this.sendToJitsu(activity).catch((err) =>
        this.logger.warn('Jitsu dispatch failed:', err.message),
    );

    // 3. Broadcast via WebSocket to connected clients
    this.activityLogGateway.broadcastActivity(activity);

    return activity;
}
```

Jitsu SDK integration:
```typescript
import { jitsuAnalytics } from '@jitsu/js';

const jitsu = jitsuAnalytics({
    host: process.env.JITSU_HOST,
    writeKey: process.env.JITSU_WRITE_KEY,
});

private async sendToJitsu(activity: ActivityLog) {
    if (!this.jitsu) return;
    await this.jitsu.track(activity.action, {
        userId: activity.userId,
        directoryId: activity.directoryId,
        actionType: activity.actionType,
        status: activity.status,
        summary: activity.summary,
        ...activity.metadata,
    });
}
```

### WebSocket Gateway (Real-time)

```typescript
@WebSocketGateway({ namespace: '/activity', cors: true })
export class ActivityLogGateway {
    @WebSocketServer()
    server: Server;

    /**
     * Broadcast new or updated activity to the user's connected clients.
     */
    broadcastActivity(activity: ActivityLog) {
        // Emit to user-specific room
        this.server.to(`user:${activity.userId}`).emit('activity', activity);
    }

    /**
     * Broadcast running count update for sidebar badge.
     */
    broadcastRunningCount(userId: string, count: number) {
        this.server.to(`user:${userId}`).emit('running-count', { count });
    }

    @SubscribeMessage('join')
    handleJoin(client: Socket, userId: string) {
        client.join(`user:${userId}`);
    }
}
```

---

## Frontend Architecture

### Sidebar Addition

Add "Activity" menu item in `DashboardSidebar.tsx`:
- Position: between Dashboard and Directories
- Icon: `Activity` from lucide-react
- Badge: Shows count of running operations (fetched via API + updated via WebSocket)
- Route: `/activity`

### Page Structure

```
apps/web/src/app/[locale]/(dashboard)/activity/
├── page.tsx                    # Server component — initial data fetch
└── activity-client.tsx         # Client component — filters, search, real-time updates

apps/web/src/components/activity-log/
├── ActivityTable.tsx           # Main table/feed view
├── ActivityRow.tsx             # Single activity row (expandable)
├── ActivityDetail.tsx          # Expanded detail view
├── ActivityFilters.tsx         # Filter bar (type, directory, status, date range)
├── ActivitySearch.tsx          # Search input
├── ActivityEmptyState.tsx      # Empty state
├── ActivityBadge.tsx           # Sidebar badge (running count)
└── ActivityExport.tsx          # Export button/dialog
```

### Table Columns

| Column | Description |
|--------|-------------|
| Status | Icon/badge: spinner (in_progress), check (completed), x (failed) |
| Date/Time | Relative time (e.g. "2 min ago") with full timestamp tooltip |
| Directory | Directory name as link, or "—" for account-level actions |
| Action Type | Colored badge (generation, deployment, plugin, etc.) |
| Summary | Human-readable description |
| Actions | Expand, retry (if failed), dismiss |

### Real-time Updates

```typescript
// useActivitySocket.ts hook
function useActivitySocket(userId: string) {
    useEffect(() => {
        const socket = io('/activity', { /* ... */ });
        socket.emit('join', userId);

        socket.on('activity', (activity) => {
            // Prepend to activity list or update existing entry
        });

        socket.on('running-count', ({ count }) => {
            // Update sidebar badge
        });

        return () => socket.disconnect();
    }, [userId]);
}
```

### Translation Keys

```json
{
    "dashboard": {
        "activity": {
            "title": "Activity Log",
            "subtitle": "Track all operations across your directories",
            "filters": {
                "allTypes": "All Types",
                "allDirectories": "All Directories",
                "allStatuses": "All Statuses",
                "dateRange": "Date Range",
                "search": "Search activities..."
            },
            "status": {
                "pending": "Pending",
                "in_progress": "In Progress",
                "completed": "Completed",
                "failed": "Failed"
            },
            "actions": {
                "retry": "Retry",
                "dismiss": "Dismiss",
                "export": "Export CSV",
                "viewDetails": "View Details"
            },
            "empty": {
                "title": "No activities yet",
                "description": "Activities will appear here as you use the platform."
            },
            "detail": {
                "duration": "Duration",
                "itemsAffected": "Items Affected",
                "error": "Error Details",
                "parameters": "Parameters",
                "viewDirectory": "View Directory"
            }
        }
    }
}
```

---

## Relationship to Existing Directory History Tab

| Aspect | Directory History Tab | Global Activity Log |
|--------|----------------------|---------------------|
| Scope | Single directory | All directories + account |
| Detail level | Deep (step logs, changelogs, metrics, tokens, cost) | Summary (status, summary, JSON details) |
| Purpose | Debug/inspect generation execution | "What happened across my account?" |
| Action types | Generation, items, comparisons, taxonomy, community PR | All operations (including deploy, plugins, auth, settings) |
| Entry source | Created by generation/import services directly | Created by ActivityLogService from event listeners + direct calls |
| Cross-reference | — | `details.historyId` links to DirectoryGenerationHistory when applicable |

Both coexist. The directory history tab remains the detailed execution trace. The activity log is the global overview.

---

## Implementation — Two PRs

The implementation is split into two separate PRs:

### PR 1: Core Activity Log (`feat/global-activity-log`)

Everything needed to make the activity log functional — backend, frontend, real-time, all integration points. No Jitsu.

**Phase 1 — Core Backend**
1. Create `ActivityLog` entity and repository
2. Create `ActivityLogService` with `log()`, `updateStatus()`, `findAll()`, `countRunning()`
3. Create `ActivityLogController` with REST endpoints
4. Create `ActivityLogModule` and register in `ApiModule`
5. Add event listeners for existing events (6 events → 6 activity types)

**Phase 2 — Integration Points**
6. Add `activityLogService.log()` calls to all services/controllers listed in the integration table above (~20 integration points)

**Phase 3 — Frontend**
7. Add sidebar menu item with badge
8. Create Activity page with table, filters, search, pagination
9. Create detail view for expanded rows
10. Add translation keys

**Phase 4 — Real-time**
11. Add WebSocket gateway for live activity broadcasting
12. Add `useActivitySocket` hook on frontend
13. Wire badge to real-time running count

**Phase 5 — Polish**
14. Export CSV functionality
15. Retry failed operations
16. Bulk dismiss
17. Date range picker filter

**Dependencies for PR 1:**

| Package | Purpose | Where |
|---------|---------|-------|
| `@nestjs/websockets` | WebSocket gateway | `apps/api` (check if already installed) |
| `socket.io` / `socket.io-client` | WebSocket transport | `apps/api` + `apps/web` |

---

### PR 2: Jitsu Analytics Integration (`feat/activity-log-jitsu`)

Once PR 1 is merged and confirmed working, add Jitsu as a secondary dispatch alongside the DB write. This is a clean, isolated change:

1. Install `@jitsu/js` in `apps/api`
2. Add `JITSU_HOST` and `JITSU_WRITE_KEY` env vars
3. Create `JitsuService` wrapper (initialize SDK, expose `track()` method)
4. Update `ActivityLogService.log()` to call `jitsuService.track()` as fire-and-forget after DB write
5. Add env vars to `.env.example` and `.env.compose`

**Dependencies for PR 2:**

| Package | Purpose | Where |
|---------|---------|-------|
| `@jitsu/js` | Jitsu analytics SDK | `apps/api` |

**Environment Variables (PR 2 only):**

```bash
# Jitsu Analytics
JITSU_HOST=https://your-jitsu-instance.com
JITSU_WRITE_KEY=your-write-key
```

**Why separate:** Jitsu is an analytics dispatch — it doesn't affect core functionality. Keeping it in its own PR means the activity log can ship and be tested independently, and the Jitsu integration can be reviewed/configured without blocking the main feature.

---

## Branch Names

- PR 1: `feat/global-activity-log`
- PR 2: `feat/activity-log-jitsu`
