import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const CLAW_WS_BASE_URL =
  process.env.CLAW_WS_BASE_URL || 'wss://claw-messenger.onrender.com/ws';
const CLAW_API_KEY_FILE =
  process.env.CLAW_API_KEY_FILE || '/run/secrets/claw_api_key';
const N8N_WEBHOOK_SECRET_FILE =
  process.env.N8N_WEBHOOK_SECRET_FILE || '/run/secrets/n8n_webhook_secret';
const N8N_WEBHOOK_URL = requiredEnv('N8N_WEBHOOK_URL');

const ALLOWED_SENDERS = new Set(
  requiredEnv('ALLOWED_SENDERS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

const ALLOW_GROUPS =
  (process.env.ALLOW_GROUPS || 'false').toLowerCase() === 'true';
const STATE_PATH = process.env.STATE_PATH || '/state/state.json';

const MAX_EVENT_BYTES = intEnv('MAX_EVENT_BYTES', 1_048_576);
const MAX_RECENT_IDS = intEnv('MAX_RECENT_IDS', 2_000);
const HEARTBEAT_INTERVAL_MS = intEnv('HEARTBEAT_INTERVAL_MS', 25_000);
const HEARTBEAT_TIMEOUT_MS = intEnv('HEARTBEAT_TIMEOUT_MS', 75_000);
const WEBHOOK_TIMEOUT_MS = intEnv('WEBHOOK_TIMEOUT_MS', 10_000);
const WEBHOOK_RETRY_DELAYS_MS = [0, 1_000, 3_000, 7_000, 15_000];

const clawApiKey = readSecret(CLAW_API_KEY_FILE);
const n8nWebhookSecret = readSecret(N8N_WEBHOOK_SECRET_FILE);
const state = loadState();
const recentIds = new Set(state.recentIds);

let socket;
let pingTimer;
let watchdogTimer;
let reconnectTimer;
let reconnectAttempt = 0;
let stopping = false;
let lastServerActivity = 0;
let processingQueue = Promise.resolve();

log('starting', {
  allowedSenderCount: ALLOWED_SENDERS.size,
  allowGroups: ALLOW_GROUPS,
});

connect();

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function intEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readSecret(path) {
  const value = readFileSync(path, 'utf8').trim();
  if (!value) {
    throw new Error(`Secret file is empty: ${path}`);
  }
  return value;
}

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return {
      recentIds: Array.isArray(parsed.recentIds)
        ? parsed.recentIds
            .filter((id) => typeof id === 'string')
            .slice(-MAX_RECENT_IDS)
        : [],
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log('state_load_failed', { error: safeError(error) });
    }
    return { recentIds: [] };
  }
}

function saveState() {
  state.recentIds = [...recentIds].slice(-MAX_RECENT_IDS);
  state.updatedAt = new Date().toISOString();

  mkdirSync(dirname(STATE_PATH), { recursive: true });

  const temporaryPath = `${STATE_PATH}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, STATE_PATH);
}

function connect() {
  if (stopping) return;

  const url = new URL(CLAW_WS_BASE_URL);
  url.searchParams.set('key', clawApiKey);

  try {
    socket = new WebSocket(url);
  } catch (error) {
    log('connection_creation_failed', { error: safeError(error) });
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    reconnectAttempt = 0;
    lastServerActivity = Date.now();
    log('connected');
    startHeartbeat();
  });

  socket.addEventListener('message', (event) => {
    lastServerActivity = Date.now();
    void receiveEvent(event.data);
  });

  socket.addEventListener('error', (event) => {
    log('websocket_error', {
      error: safeError(event?.error || event?.message || 'unknown'),
    });
  });

  socket.addEventListener('close', (event) => {
    stopHeartbeat();
    log('disconnected', {
      code: event.code,
      clean: event.wasClean,
    });
    scheduleReconnect();
  });
}

function startHeartbeat() {
  stopHeartbeat();

  pingTimer = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      send({ type: 'ping' });
    }
  }, HEARTBEAT_INTERVAL_MS);

  watchdogTimer = setInterval(() => {
    if (
      socket?.readyState === WebSocket.OPEN &&
      Date.now() - lastServerActivity > HEARTBEAT_TIMEOUT_MS
    ) {
      log('heartbeat_timeout');
      socket.close(4000, 'heartbeat timeout');
    }
  }, 10_000);
}

function stopHeartbeat() {
  clearInterval(pingTimer);
  clearInterval(watchdogTimer);
  pingTimer = undefined;
  watchdogTimer = undefined;
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;

  const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;

  log('reconnect_scheduled', { delayMs: delay });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay);
}

async function receiveEvent(data) {
  let raw;
  try {
    raw = await dataToString(data);
  } catch (error) {
    log('event_decode_failed', { error: safeError(error) });
    return;
  }

  if (Buffer.byteLength(raw, 'utf8') > MAX_EVENT_BYTES) {
    log('event_too_large');
    socket?.close(1009, 'event too large');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    log('invalid_json_received');
    return;
  }

  if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') {
    log('invalid_event_shape');
    return;
  }

  switch (payload.type) {
    case 'ping':
      send({ type: 'pong' });
      return;

    case 'pong':
      return;

    case 'message':
      processingQueue = processingQueue
        .then(() => forwardMessage(payload))
        .catch((error) => {
          log('message_forward_failed', {
            messageId: safeId(payload.messageId),
            error: safeError(error),
          });
        });
      return;

    default:
      log('event_ignored', { type: payload.type });
      return;
  }
}

async function forwardMessage(payload) {
  const messageId =
    typeof payload.messageId === 'string' ? payload.messageId.trim() : '';
  const sender =
    typeof payload.from === 'string' ? payload.from.trim() : '';

  if (!messageId || !sender) {
    log('message_rejected_invalid_shape');
    return;
  }

  if (recentIds.has(messageId)) {
    log('duplicate_skipped', { messageId: safeId(messageId) });
    return;
  }

  if (!ALLOWED_SENDERS.has(sender)) {
    log('sender_rejected', { messageId: safeId(messageId) });
    markProcessed(messageId);
    return;
  }

  if (payload.isGroup === true && !ALLOW_GROUPS) {
    log('group_rejected', { messageId: safeId(messageId) });
    markProcessed(messageId);
    return;
  }

  const outgoingPayload = {
    type: 'message',
    messageId,
    chatId: typeof payload.chatId === 'string' ? payload.chatId : null,
    from: sender,
    text: typeof payload.text === 'string' ? payload.text : '',
    attachments: sanitiseAttachments(payload.attachments),
    service: typeof payload.service === 'string' ? payload.service : null,
    isGroup: payload.isGroup === true,
    participants: Array.isArray(payload.participants)
      ? payload.participants
          .filter((value) => typeof value === 'string')
          .slice(0, 100)
      : [],
    replay: payload.replay === true,
    bridgeReceivedAt: new Date().toISOString(),
  };

  await postToN8n(outgoingPayload);
  markProcessed(messageId);

  log('message_forwarded', {
    messageId: safeId(messageId),
    replay: outgoingPayload.replay,
    hasAttachments: outgoingPayload.attachments.length > 0,
  });
}

function sanitiseAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];

  return attachments.slice(0, 20).flatMap((attachment) => {
    if (!attachment || typeof attachment !== 'object') return [];

    const url = typeof attachment.url === 'string' ? attachment.url : null;
    const mimeType =
      typeof attachment.mimeType === 'string' ? attachment.mimeType : null;

    if (!url && !mimeType) return [];
    return [{ url, mimeType }];
  });
}

async function postToN8n(body) {
  let lastError;

  for (const delayMs of WEBHOOK_RETRY_DELAYS_MS) {
    if (delayMs > 0) await sleep(delayMs);

    try {
      const response = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${n8nWebhookSecret}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });

      await response.arrayBuffer();

      if (response.ok) return;

      lastError = new Error(`n8n webhook returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('n8n webhook delivery failed');
}

function markProcessed(messageId) {
  recentIds.delete(messageId);
  recentIds.add(messageId);

  while (recentIds.size > MAX_RECENT_IDS) {
    recentIds.delete(recentIds.values().next().value);
  }

  saveState();
}

function send(payload) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

async function dataToString(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      'utf8',
    );
  }
  if (data && typeof data.text === 'function') return data.text();
  return String(data);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeId(value) {
  if (typeof value !== 'string' || !value) return undefined;
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function safeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replaceAll(clawApiKey, '[redacted]')
    .replaceAll(n8nWebhookSecret, '[redacted]')
    .slice(0, 300);
}

function log(event, details = {}) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...details,
    }),
  );
}

function shutdown(signal) {
  if (stopping) return;

  stopping = true;
  log('shutting_down', { signal });
  clearTimeout(reconnectTimer);
  stopHeartbeat();

  if (
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  ) {
    socket.close(1000, 'shutdown');
  }

  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  log('uncaught_exception', { error: safeError(error) });
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  log('unhandled_rejection', { error: safeError(error) });
  process.exit(1);
});
