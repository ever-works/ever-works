# @ever-works/whatsapp-channel-plugin

WhatsApp notification channel for the Ever Works platform.

- **Capabilities**: `notification-channel`, `notification-channel-whatsapp`
- **Shape**: `direct` (one recipient per channel)
- **Transport**: WhatsApp Business Cloud API (`/{phoneNumberId}/messages`)

## Settings (channel-level `targetConfig`)

| Key             | Required | Description                                  |
| --------------- | -------- | -------------------------------------------- |
| `accessToken`   | Yes      | Meta system-user access token                |
| `phoneNumberId` | Yes      | WhatsApp Business phone-number id            |
| `to`            | Yes      | Recipient phone (E.164, e.g. `+15551234567`) |

## Plugin-level settings (tenant default)

| Key          | Description                             |
| ------------ | --------------------------------------- |
| `apiVersion` | Graph API version (defaults to `v21.0`) |

## 24-hour window rule

WhatsApp only allows free-form **text** within 24h of the recipient's last
message. Outside that window you MUST send a pre-approved **template**. Supply
the `whatsapp-template` rich payload kind (`{ name, language, components }`) for
guaranteed delivery; plain `text` is best-effort (in-window only).

`verifyTarget` does a Graph API GET on the phone-number id to confirm the token.

Refs spec: [`docs/specs/features/notification-channels/spec.md`](../../../docs/specs/features/notification-channels/spec.md) §6.
