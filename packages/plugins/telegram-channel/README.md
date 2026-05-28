# @ever-works/telegram-channel-plugin

Telegram notification channel for the Ever Works platform.

- **Capabilities**: `notification-channel`, `notification-channel-telegram`
- **Shape**: `direct` (one chat per channel)
- **Transport**: Telegram Bot API `sendMessage` (MarkdownV2 via the `telegram-markdown` rich payload kind)

## Settings (channel-level `targetConfig`)

| Key | Required | Description |
|-----|----------|-------------|
| `botToken` | Yes | Bot token from @BotFather |
| `chatId` | Yes | Destination chat id |

## Plugin-level settings (tenant default)

| Key | Description |
|-----|-------------|
| `disableNotification` | Send silently (no sound/vibration) |

## Finding your chat id

1. Create a bot with [@BotFather](https://t.me/BotFather) → get the `botToken`.
2. Send any message to the bot (or add it to a group).
3. `GET https://api.telegram.org/bot<botToken>/getUpdates` → read `result[].message.chat.id`.
4. Use that value as `chatId`.

`verifyTarget` calls `getMe` to confirm the token is valid before the first send.

Refs spec: [`docs/specs/features/notification-channels/spec.md`](../../../docs/specs/features/notification-channels/spec.md) §6.
