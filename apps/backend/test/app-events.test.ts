import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { createPool } from '../src/db/pool.js';
import {
  MAX_APP_EVENT_PAYLOAD_BYTES,
  createAppEventSubscriber,
  publishAppEvent,
  type AppEvent,
  type AppEventSubscriber,
} from '../src/events/bus.js';

/**
 * The app-event bus is deliberately generic (NBK-6): ingestion stage
 * transitions are only its first publisher — chat answer chunks and other
 * background-task events ride the same channel later. These tests therefore
 * exercise it with arbitrary event types, never ingestion-specific ones.
 *
 * It needs a real Postgres because LISTEN/NOTIFY is the whole mechanism: the
 * point is that a *different process* than the publisher receives the event.
 * A separate `pg.Client` standing in for that other process is the closest
 * in-test equivalent.
 */
describe('app event bus', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let subscriber: AppEventSubscriber;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = createPool(container.getConnectionUri());
    subscriber = await createAppEventSubscriber(container.getConnectionUri());
  }, 180_000);

  afterAll(async () => {
    await subscriber.close();
    await pool.end();
    await container.stop();
  });

  /** Resolves with the first event a listener sees that passes `matches`. */
  function nextEvent(matches: (event: AppEvent) => boolean): Promise<AppEvent> {
    return new Promise<AppEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error('No matching app event arrived within 10s.'));
      }, 10_000);
      const unsubscribe = subscriber.subscribe((event) => {
        if (!matches(event)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      });
    });
  }

  it('delivers a published event to a subscriber on another connection', async () => {
    const arrived = nextEvent((event) => event.type === 'test-thing-happened');

    const published = await publishAppEvent(pool, {
      type: 'test-thing-happened',
      topic: 'notebook:11111111-1111-1111-1111-111111111111',
      data: { answer: 42 },
    });

    const event = await arrived;
    expect(event.id).toBe(published.id);
    expect(event.topic).toBe('notebook:11111111-1111-1111-1111-111111111111');
    expect(event.data).toEqual({ answer: 42 });
    expect(Date.parse(event.occurredAt)).not.toBeNaN();
  });

  it('rejects a payload too large for a Postgres NOTIFY', async () => {
    await expect(
      publishAppEvent(pool, {
        type: 'test-oversized',
        topic: 'notebook:11111111-1111-1111-1111-111111111111',
        data: { blob: 'x'.repeat(MAX_APP_EVENT_PAYLOAD_BYTES) },
      }),
    ).rejects.toThrow(/too large/i);
  });
});
