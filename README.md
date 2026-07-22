# Claw Messenger → n8n WebSocket Listener

A small, hardened WebSocket listener that receives inbound Claw Messenger events and forwards allowed messages into an n8n Webhook workflow.

It is intended for self-hosted n8n users who want two-way Claw/iMessage-style workflows without installing an n8n community WebSocket node.

```text
Claw Messenger WebSocket
        ↓
claw-listener container
        ↓ HTTP POST over Docker network
n8n Webhook workflow
        ↓
AI Agent / tools / memory
        ↓
Claw Messenger send node
```

## What this does

The listener:

- connects to Claw's WebSocket endpoint;
- sends `{"type":"ping"}` periodically;
- replies with `{"type":"pong"}` when Claw sends a ping;
- forwards only `message` events to n8n;
- ignores non-message events such as `status`;
- deduplicates recent `messageId` values;
- retries failed n8n webhook delivery;
- restricts inbound forwarding to an explicit phone-number allowlist;
- stores secrets as Docker Compose secrets, not plain environment variables;
- runs with no public ports, non-root user, read-only filesystem, dropped Linux capabilities and no privilege escalation.

## What this does not do

It does not send outbound messages itself. Use the official Claw Messenger n8n action node, an HTTP node, or another trusted outbound mechanism inside n8n.

It does not currently issue Claw's optional manual startup `sync` request. In testing, live delivery was reliable without startup sync, and issuing `sync` immediately on open caused some Claw sessions to close. Recent message IDs are still deduplicated locally.

## Requirements

- A self-hosted n8n instance running in Docker.
- Docker Compose.
- A valid Claw Messenger API key.
- An active n8n workflow with a production Webhook Trigger.
- Node image access from the host, via Docker.

## Quick start

Clone the repository on the same server as n8n:

```bash
git clone https://github.com/lwhit24/claw-n8n-websocket-listener.git
cd claw-n8n-websocket-listener
cp .env.example .env
```

Edit `.env`:

```bash
nano .env
```

Set:

```env
N8N_NETWORK=n8n_default
N8N_CONTAINER=n8n
N8N_WEBHOOK_PATH=/webhook/claw-inbound-your-random-path
ALLOWED_SENDERS=+447700900000
ALLOW_GROUPS=false
```

Create the secret files:

```bash
mkdir -p secrets state
nano secrets/claw_api_key
```

Paste the Claw API key only, with no quotes.

Generate the n8n webhook secret:

```bash
openssl rand -hex 32 > secrets/n8n_webhook_secret
```

Protect local files:

```bash
chmod 700 secrets state
chmod 400 secrets/claw_api_key secrets/n8n_webhook_secret
chmod 600 .env
```

Because the container runs as user `65532`, make the secret files readable by that user:

```bash
sudo chown 65532:65532 secrets/claw_api_key secrets/n8n_webhook_secret
sudo chown -R 65532:65532 state
```

## n8n workflow setup

Create a new n8n workflow:

```text
Webhook → Code → AI Agent → Claw Messenger Send Message
```

Configure the Webhook node:

```text
Method: POST
Path: claw-inbound-your-random-path
Authentication: Header Auth
Header Name: Authorization
Header Value: Bearer <contents of secrets/n8n_webhook_secret>
Respond: Immediately
Response Code: 202
```

Use the **Production URL**, not the test URL. The `.env` value should include the production path:

```env
N8N_WEBHOOK_PATH=/webhook/claw-inbound-your-random-path
```

Add a Code node after the Webhook node:

```js
const input = $input.first().json;
const body = input.body;

if (
  !body ||
  body.type !== 'message' ||
  typeof body.messageId !== 'string' ||
  typeof body.from !== 'string' ||
  typeof body.text !== 'string'
) {
  throw new Error('Invalid Claw Messenger payload');
}

return [
  {
    json: body,
  },
];
```

The clean message item then contains:

```json
{
  "type": "message",
  "messageId": "abc123",
  "chatId": "chat-456",
  "from": "+447700900000",
  "text": "Hello",
  "attachments": [],
  "service": "iMessage",
  "isGroup": false,
  "participants": [],
  "replay": false,
  "bridgeReceivedAt": "2026-01-01T12:00:00.000Z"
}
```

For the Claw Messenger send node, use the incoming sender as the recipient:

```js
{{ $json.from }}
```

## Start the listener

Validate the Compose file:

```bash
docker compose config
```

Start:

```bash
docker compose up -d
```

View logs:

```bash
docker compose logs -f --tail=30
```

Expected startup:

```json
{"event":"starting","allowedSenderCount":1,"allowGroups":false}
{"event":"connected"}
```

Send a test message from an allowlisted number. Expected log:

```json
{"event":"message_forwarded","messageId":"abc123...","replay":false,"hasAttachments":false}
```

## Health checks and troubleshooting

Check the container:

```bash
docker compose ps
```

Check mounts and hardening:

```bash
docker inspect claw-listener \
  --format 'User={{.Config.User}} ReadOnly={{.HostConfig.ReadonlyRootfs}} Privileged={{.HostConfig.Privileged}} Ports={{json .NetworkSettings.Ports}}'
```

Expected:

```text
User=65532:65532 ReadOnly=true Privileged=false Ports={}
```

Check the Claw API key without printing it:

```bash
docker run --rm \
  -v "$PWD/secrets/claw_api_key:/run/key:ro" \
  node:24-alpine \
  node -e "
const fs = require('fs');
const key = fs.readFileSync('/run/key','utf8').trim();
fetch('https://claw-messenger.onrender.com/api/agent/readiness', {
  headers: { Authorization: 'Bearer ' + key }
})
.then(async r => {
  console.log('HTTP ' + r.status);
  console.log(await r.text());
})
.catch(e => {
  console.error(e.message);
  process.exit(2);
});
"
```

Common issues:

### `HTTP 401 {"detail":"Invalid API Key"}`

The Claw API key is invalid, incomplete, copied from the wrong place, or revoked. Replace `secrets/claw_api_key`.

### `sender_rejected`

The message came from a phone number not listed in `ALLOWED_SENDERS`. Use E.164 format, for example `+447...`.

### `n8n webhook returned HTTP 401`

The n8n Header Auth credential does not match `secrets/n8n_webhook_secret`. The n8n value must be:

```text
Bearer <secret>
```

### `n8n webhook returned HTTP 404`

The n8n workflow is not active, the path is wrong, or `.env` is using the test webhook path instead of the production path.

### Connected but no n8n execution

Check that the message is being sent from an allowlisted and Claw-registered sender, in the correct Claw conversation.

## Security notes

This listener is designed so that the Claw API key and n8n webhook secret are only available to the listener container.

Recommended practices:

- Do not commit anything in `secrets/`.
- Do not commit `.env`.
- Rotate the n8n webhook secret if it appears in screenshots, logs or shared n8n executions.
- Consider disabling or redacting successful execution data in n8n because webhook headers and message bodies can be stored in execution history.
- Do not expose this container through a public port.
- Keep `ALLOW_GROUPS=false` unless you explicitly support group-message handling.

## Updating

Pull a newer Node image and recreate the container:

```bash
docker compose pull
docker compose up -d --force-recreate
docker compose logs --since=30s
```

## Uninstall

```bash
docker compose down
```

Then remove the directory if no longer needed:

```bash
cd ..
rm -rf claw-n8n-websocket-listener
```

## License

MIT
