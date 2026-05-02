---
id: ai-conversation
title: AI Conversation API
sidebar_label: AI Conversation
sidebar_position: 4
---

# AI Conversation API

The AI Conversation API provides a stateless, streaming chat endpoint for interacting with the platform's AI. It can be scoped to a specific work for context-aware responses.

All endpoints require JWT authentication.

## Endpoint

| Method | Endpoint                            | Description                                          |
| ------ | ----------------------------------- | ---------------------------------------------------- |
| `POST` | `/api/ai-conversations/chat/stream` | Send a chat message and receive a streaming response |

## Chat Stream

Send a message and receive a streaming NDJSON response:

```bash
curl -X POST http://localhost:3100/api/ai-conversations/chat/stream \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "role": "user", "content": "What categories should I use for a design tools work?" }
    ],
    "workId": "optional-work-id"
  }'
```

### Request Body

| Field              | Type   | Required | Description                                    |
| ------------------ | ------ | -------- | ---------------------------------------------- |
| `messages`         | array  | Yes      | Array of chat messages (`{ role, content }`)   |
| `model`            | string | No       | Override the AI model                          |
| `temperature`      | number | No       | Override the temperature                       |
| `workId`      | string | No       | Scope the conversation to a specific work |
| `providerOverride` | string | No       | Override the AI provider plugin                |

### Response

The response is a stream of newline-delimited JSON (NDJSON). Each line is a JSON object:

```
{"content":"Here"}
{"content":" are"}
{"content":" some"}
{"content":" suggested"}
{"content":" categories"}
{"done":true}
```

| Field     | Type    | Description                           |
| --------- | ------- | ------------------------------------- |
| `content` | string  | A chunk of the AI response text       |
| `done`    | boolean | `true` when the response is complete  |
| `error`   | string  | Error message if something went wrong |
