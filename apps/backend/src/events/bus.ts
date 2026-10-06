import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { appEventSchema, type AppEvent, type AppEventDraft } from "./schema.js";

/**
 * The single Postgres NOTIFY channel every app event travels on (NBK-6).
 *
 * Why Postgres LISTEN/NOTIFY rather than an in-process emitter: the pg_boss
 * worker that publishes an event and the HTTP process holding a client's SSE
 * connection are not necessarily the same process (and in a scaled-out
 * deployment definitely aren't). Postgres is already a shared dependency of
 * both, so it is also the message bus — no extra broker.
 *
 * One channel for everything, with per-event `topic` filtering done by the
 * subscriber, rather than a channel per notebook: `LISTEN` is per-connection
 * and a connection can't cheaply follow a channel set that changes as users
 * come and go.
 */
export const APP_EVENT_CHANNEL = "app_events";

/**
 * Postgres caps a NOTIFY payload at 8000 bytes. Events are notifications
 * ("this changed"), not data transfer, so staying well inside that is a
 * design constraint on publishers, not something to work around: anything
 * bulky belongs in a table the client then fetches.
 */
export const MAX_APP_EVENT_PAYLOAD_BYTES = 7000;

/**
 * Publishes an event to every subscriber, on any process, via
 * `pg_notify`. `id` and `occurredAt` are stamped here so a publisher only
 * ever says what happened.
 *
 * `pg_notify` is transactional: called inside a transaction, the notification
 * is only delivered if that transaction commits. Callers that update a row
 * and announce the change in the same transaction therefore can't announce a
 * change that got rolled back.
 */
export async function publishAppEvent(
  executor: Pool | Client,
  draft: AppEventDraft,
): Promise<AppEvent> {
  const event: AppEvent = {
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    ...draft,
  };

  const payload = JSON.stringify(event);
  const size = Buffer.byteLength(payload, "utf8");
  if (size > MAX_APP_EVENT_PAYLOAD_BYTES) {
    throw new Error(
      `App event "${event.type}" is too large to publish (${size} bytes, limit ${MAX_APP_EVENT_PAYLOAD_BYTES}). ` +
        "Put the bulk in a table and let the client fetch it.",
    );
  }

  await executor.query("SELECT pg_notify($1, $2)", [APP_EVENT_CHANNEL, payload]);
  return event;
}

export type AppEventListener = (event: AppEvent) => void;

export interface AppEventSubscriber {
  /** Registers `listener` for every event; call the returned function to stop. */
  subscribe(listener: AppEventListener): () => void;
  close(): Promise<void>;
}

/**
 * Opens a dedicated Postgres connection that `LISTEN`s on
 * {@link APP_EVENT_CHANNEL} and fans every event out to its local listeners.
 *
 * Deliberately NOT a connection borrowed from the app's `Pool`: `LISTEN` is
 * bound to one physical connection for as long as you want notifications, so
 * holding a pooled client hostage for the process's lifetime would starve the
 * pool. One long-lived `Client` per process instead.
 *
 * Reconnects with a fixed backoff if the connection drops. Events published
 * while disconnected are lost — NOTIFY has no replay — which is why this
 * carries notifications and not state: a client that reconnects re-fetches
 * the current truth over the normal REST routes.
 */
export async function createAppEventSubscriber(connectionString: string): Promise<AppEventSubscriber> {
  const listeners = new Set<AppEventListener>();
  let closed = false;
  let client: Client | null = null;

  function handleNotification(payload: string | undefined): void {
    if (!payload) return;
    let event: AppEvent;
    try {
      event = appEventSchema.parse(JSON.parse(payload));
    } catch {
      // Something else is notifying on our channel, or an older/newer
      // deployment speaks a shape we don't. Dropping it is strictly better
      // than tearing the subscriber down.
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // One misbehaving listener (e.g. an SSE connection that died between
        // the socket closing and its cleanup running) must not stop the rest.
      }
    }
  }

  async function connect(): Promise<void> {
    if (closed) return;
    const next = new Client({ connectionString });
    next.on("notification", (message) => handleNotification(message.payload));
    next.on("error", () => {
      // `end()` on an already-broken client throws; the 'end' handler below
      // is what actually schedules the reconnect.
    });
    next.on("end", () => {
      if (closed) return;
      client = null;
      setTimeout(() => void connect().catch(() => {}), 1000);
    });
    await next.connect();
    await next.query(`LISTEN ${APP_EVENT_CHANNEL}`);
    client = next;
  }

  await connect();

  return {
    subscribe(listener: AppEventListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close(): Promise<void> {
      closed = true;
      listeners.clear();
      const current = client;
      client = null;
      if (current) {
        await current.end().catch(() => {});
      }
    },
  };
}

export type { AppEvent, AppEventDraft } from "./schema.js";
