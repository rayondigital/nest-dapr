import { Server } from 'http';
import { Logger } from '@nestjs/common';
import AsyncLock from 'async-lock';
import axios, { AxiosInstance } from 'axios';
import bodyParser from 'body-parser';
import express from 'express';

export type SidecarOptions = {
  host: string;
  port: number; // sidecar HTTP port — what DAPR_HTTP_PORT points to
  appHost: string;
  appPort: number; // your NestJS app port — what DAPR_SERVER_PORT points to
};

type ReminderRegistration = {
  dueTime?: string;
  period?: string;
  ttl?: string;
  data?: any;
};

type TimerRegistration = ReminderRegistration & {
  callback?: string;
};

type ScheduledInvocation = {
  timeout?: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
  expiresAt?: number;
};

export class DaprSidecarEmulator {
  private readonly logger = new Logger(DaprSidecarEmulator.name);
  private readonly app = express();
  private readonly http: AxiosInstance;
  private readonly actorLock = new AsyncLock({
    domainReentrant: true,
    timeout: 30_000,
    maxOccupationTime: 5_000,
    maxExecutionTime: 5_000,
    maxPending: 100,
  });

  private server?: Server;
  private stopping = false;

  private readonly actorState = new Map<string, Map<string, any>>();
  private readonly stateStore = new Map<string, Map<string, any>>();
  private readonly reminders = new Map<string, ScheduledInvocation>();
  private readonly timers = new Map<string, ScheduledInvocation>();
  private readonly locks = new Map<string, { owner: string; expiresAt: number }>();

  constructor(private readonly options: SidecarOptions) {
    this.http = axios.create({ timeout: 30_000, validateStatus: () => true });

    this.app.use(
      bodyParser.json({
        type: ['application/json', 'application/cloudevents+json', 'application/*+json'],
        limit: '10mb',
      }),
    );
    this.app.use(
      bodyParser.text({
        type: ['text/*', 'application/octet-stream'],
        limit: '10mb',
      }),
    );

    this.registerRoutes();
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.stopping = false;

    await new Promise<void>((resolve, reject) => {
      const server = this.app.listen(this.options.port, this.options.host, () => {
        this.server = server;
        resolve();
      });
      server.once('error', reject);
    });

    this.logger.log(
      `Dapr sidecar emulator started on ${this.options.host}:${this.options.port} ` +
        `(app ${this.options.appHost}:${this.options.appPort})`,
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;

    for (const inv of this.reminders.values()) this.cancelInvocation(inv);
    this.reminders.clear();
    for (const inv of this.timers.values()) this.cancelInvocation(inv);
    this.timers.clear();

    if (!this.server) return;
    const server = this.server;
    this.server = undefined;

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    this.logger.log('Dapr sidecar emulator stopped');
  }

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  private registerRoutes() {
    // Health — the Dapr SDK polls this to confirm the sidecar is ready
    this.app.get('/v1.0/healthz', (_req, res) => {
      res.status(200).send();
    });

    // Metadata
    this.app.get('/v1.0/metadata', (_req, res) => {
      res.json({ id: process.env.DAPR_APP_ID ?? 'test', components: [] });
    });

    // Shutdown
    this.app.post('/v1.0/shutdown', async (_req, res) => {
      await this.stop();
      res.status(204).send();
    });

    // State store — save
    this.app.post('/v1.0/state/:storeName', (req, res) => {
      const store = this.storeFor(req.params.storeName);
      for (const item of Array.isArray(req.body) ? req.body : []) {
        if (typeof item?.key === 'string') store.set(item.key, item.value);
      }
      res.status(204).send();
    });

    // State store — get
    this.app.get('/v1.0/state/:storeName/:key', (req, res) => {
      const store = this.storeFor(req.params.storeName);
      store.has(req.params.key) ? res.json(store.get(req.params.key)) : res.status(204).send();
    });

    // State store — delete
    this.app.delete('/v1.0/state/:storeName/:key', (req, res) => {
      this.storeFor(req.params.storeName).delete(req.params.key);
      res.status(204).send();
    });

    // State store — bulk get
    this.app.post('/v1.0/state/:storeName/bulk', (req, res) => {
      const store = this.storeFor(req.params.storeName);
      const keys: string[] = Array.isArray(req.body?.keys) ? req.body.keys : [];
      res.json(keys.map((key) => ({ key, data: store.get(key) ?? null })));
    });

    // State store — transaction (upsert/delete applied atomically to the in-memory map)
    this.app.post('/v1.0/state/:storeName/transaction', (req, res) => {
      const store = this.storeFor(req.params.storeName);
      const operations = Array.isArray(req.body?.operations) ? req.body.operations : [];
      for (const op of operations) {
        const key = op?.request?.key;
        if (typeof key !== 'string') continue;
        if (op.operation === 'delete') store.delete(key);
        else store.set(key, op.request.value);
      }
      res.status(204).send();
    });

    // Actor method invocation — proxy to app
    this.app.post('/v1.0/actors/:actorType/:actorId/method/:methodName', async (req, res) => {
      const { actorType, actorId, methodName } = req.params;
      try {
        await this.withActorLock(actorType, actorId, () =>
          this.proxyToApp(
            'put',
            `/actors/${enc(actorType)}/${enc(actorId)}/method/${enc(methodName)}`,
            req.body,
            req.headers,
            res,
          ),
        );
      } catch (err) {
        this.logger.error(`Actor method failed ${actorType}/${actorId}/${methodName}: ${msg(err)}`);
        if (!res.headersSent) res.status(500).json({ error: 'actor_invocation_failed' });
      }
    });

    // Actor state — save
    this.app.post('/v1.0/actors/:actorType/:actorId/state', (req, res) => {
      const { actorType, actorId } = req.params;
      const state = this.actorStateFor(actorType, actorId);

      for (const op of Array.isArray(req.body) ? req.body : []) {
        const key: string = op?.request?.key;
        if (!key) continue;
        if (op.operation === 'upsert') state.set(key, op.request.value);
        else if (op.operation === 'delete') state.delete(key);
      }

      res.status(204).send();
    });

    // Actor state — get
    this.app.get('/v1.0/actors/:actorType/:actorId/state/:key', (req, res) => {
      const { actorType, actorId, key } = req.params;
      const state = this.actorStateFor(actorType, actorId);
      state.has(key) ? res.json(state.get(key)) : res.status(204).send();
    });

    // Reminders
    this.app.post('/v1.0/actors/:actorType/:actorId/reminders/:name', (req, res) => {
      const { actorType, actorId, name } = req.params;
      this.scheduleReminder(actorType, actorId, name, req.body ?? {});
      res.status(204).send();
    });

    this.app.delete('/v1.0/actors/:actorType/:actorId/reminders/:name', (req, res) => {
      const { actorType, actorId, name } = req.params;
      this.cancel(this.reminders, schedKey(actorType, actorId, name));
      res.status(204).send();
    });

    // Timers
    this.app.post('/v1.0/actors/:actorType/:actorId/timers/:name', (req, res) => {
      const { actorType, actorId, name } = req.params;
      this.scheduleTimer(actorType, actorId, name, req.body ?? {});
      res.status(204).send();
    });

    this.app.delete('/v1.0/actors/:actorType/:actorId/timers/:name', (req, res) => {
      const { actorType, actorId, name } = req.params;
      this.cancel(this.timers, schedKey(actorType, actorId, name));
      res.status(204).send();
    });

    // PubSub — single message
    this.app.post('/v1.0/publish/:pubsubName/:topic', async (req, res) => {
      const { pubsubName, topic } = req.params;
      try {
        await this.dispatchPubSub(pubsubName, topic, req.body);
        res.status(204).send();
      } catch (err) {
        if (this.isShutdownError(err)) {
          res.status(204).send();
          return;
        }
        this.logger.error(`PubSub publish failed ${pubsubName}/${topic}: ${msg(err)}`);
        res.status(500).json({ error: 'pubsub_publish_failed' });
      }
    });

    // Distributed lock — acquire
    this.app.post('/v1.0-alpha1/lock/:storeName', (req, res) => {
      const { storeName } = req.params;
      const { resourceId, lockOwner, expiryInSeconds } = req.body ?? {};
      const key = this.lockKey(storeName, resourceId);
      const existing = this.locks.get(key);
      const now = Date.now();

      if (existing && existing.expiresAt > now) {
        res.json({ success: false });
        return;
      }

      this.locks.set(key, { owner: lockOwner, expiresAt: now + (Number(expiryInSeconds) || 0) * 1000 });
      res.json({ success: true });
    });

    // Distributed lock — release
    this.app.post('/v1.0-alpha1/unlock/:storeName', (req, res) => {
      const { storeName } = req.params;
      const { resourceId, lockOwner } = req.body ?? {};
      const key = this.lockKey(storeName, resourceId);
      const existing = this.locks.get(key);

      if (!existing || existing.expiresAt <= Date.now()) {
        this.locks.delete(key);
        res.json({ status: 1 }); // LockDoesNotExist
        return;
      }
      if (existing.owner !== lockOwner) {
        res.json({ status: 2 }); // LockBelongsToOthers
        return;
      }
      this.locks.delete(key);
      res.json({ status: 0 }); // Success
    });

    // PubSub — bulk
    this.app.post('/v1.0-alpha1/publish/bulk/:pubsubName/:topic', async (req, res) => {
      const { pubsubName, topic } = req.params;
      try {
        for (const entry of Array.isArray(req.body) ? req.body : []) {
          await this.dispatchPubSub(pubsubName, topic, entry?.event);
        }
        res.status(204).send();
      } catch (err) {
        if (this.isShutdownError(err)) {
          res.status(204).send();
          return;
        }
        this.logger.error(`Bulk pubsub failed ${pubsubName}/${topic}: ${msg(err)}`);
        res.status(500).json({ error: 'pubsub_bulk_publish_failed' });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Actor state
  // ---------------------------------------------------------------------------

  private actorStateFor(actorType: string, actorId: string): Map<string, any> {
    const key = `${actorType}::${actorId}`;
    if (!this.actorState.has(key)) this.actorState.set(key, new Map());
    return this.actorState.get(key)!;
  }

  private storeFor(storeName: string): Map<string, any> {
    if (!this.stateStore.has(storeName)) this.stateStore.set(storeName, new Map());
    return this.stateStore.get(storeName)!;
  }

  private lockKey(storeName: string, resourceId: string): string {
    return `${storeName}::${resourceId}`;
  }

  // ---------------------------------------------------------------------------
  // Reminders & timers
  // ---------------------------------------------------------------------------

  private scheduleReminder(actorType: string, actorId: string, name: string, reg: ReminderRegistration) {
    this.schedule(this.reminders, schedKey(actorType, actorId, name), reg.dueTime, reg.period, reg.ttl, () =>
      this.withActorLock(actorType, actorId, () =>
        this.http.put(this.appUrl(`/actors/${enc(actorType)}/${enc(actorId)}/method/remind/${enc(name)}`), {
          dueTime: reg.dueTime,
          period: reg.period,
          ttl: reg.ttl,
          data: reg.data,
        }),
      ),
    );
  }

  private scheduleTimer(actorType: string, actorId: string, name: string, reg: TimerRegistration) {
    this.schedule(this.timers, schedKey(actorType, actorId, name), reg.dueTime, reg.period, reg.ttl, () =>
      this.withActorLock(actorType, actorId, () =>
        this.http.put(this.appUrl(`/actors/${enc(actorType)}/${enc(actorId)}/method/timer/${enc(name)}`), {
          callback: reg.callback,
          dueTime: reg.dueTime,
          period: reg.period,
          ttl: reg.ttl,
          data: reg.data,
        }),
      ),
    );
  }

  private schedule(
    map: Map<string, ScheduledInvocation>,
    key: string,
    dueTime: string | undefined,
    period: string | undefined,
    ttl: string | undefined,
    callback: () => Promise<any>,
  ) {
    this.cancel(map, key);

    const dueMs = parseDuration(dueTime) ?? 0;
    const periodMs = parseDuration(period) ?? 0;
    const ttlMs = parseDuration(ttl);

    const inv: ScheduledInvocation = { expiresAt: ttlMs ? Date.now() + ttlMs : undefined };

    const fire = async () => {
      if (inv.expiresAt && Date.now() > inv.expiresAt) {
        this.cancel(map, key);
        return;
      }
      try {
        await callback();
      } catch (err) {
        this.logger.warn(`Scheduled invocation failed for ${key}: ${msg(err)}`);
      }
      if (!periodMs) this.cancel(map, key);
    };

    inv.timeout = setTimeout(() => {
      void fire();
      if (periodMs > 0) {
        inv.interval = setInterval(() => void fire(), periodMs);
        inv.interval.unref?.();
      }
    }, dueMs);
    inv.timeout.unref?.();

    map.set(key, inv);
  }

  private cancel(map: Map<string, ScheduledInvocation>, key: string) {
    const inv = map.get(key);
    if (inv) {
      this.cancelInvocation(inv);
      map.delete(key);
    }
  }

  private cancelInvocation(inv: ScheduledInvocation) {
    if (inv.timeout) clearTimeout(inv.timeout);
    if (inv.interval) clearInterval(inv.interval);
  }

  // ---------------------------------------------------------------------------
  // PubSub dispatch
  // ---------------------------------------------------------------------------

  private async dispatchPubSub(pubsubName: string, topic: string, payload: any): Promise<void> {
    let res;
    try {
      res = await this.http.get(this.appUrl('/dapr/subscribe'));
    } catch (err) {
      if (this.isShutdownError(err)) return;
      throw err;
    }

    if (res.status >= 400) return;

    const subscriptions: any[] = Array.isArray(res.data) ? res.data : [];

    for (const sub of subscriptions) {
      if (!sub || sub.pubsubname !== pubsubName || !topicMatches(sub.topic, topic)) continue;

      const route = resolveRoute(sub);
      if (!route) continue;

      try {
        await this.http.post(this.appUrl(route), { data: payload });
      } catch (err) {
        if (this.isShutdownError(err)) return;
        throw err;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Proxy
  // ---------------------------------------------------------------------------

  private async proxyToApp(
    method: 'put' | 'post',
    path: string,
    body: any,
    incomingHeaders: any,
    res: express.Response,
  ): Promise<void> {
    const headers: Record<string, string> = {};
    for (const name of ['content-type', 'dapr-reentrancy-id', 'x-correlation-id', 'traceparent']) {
      const value = incomingHeaders?.[name];
      if (value) headers[name] = Array.isArray(value) ? value.join(',') : value;
    }

    const r = await this.http.request({ method, url: this.appUrl(path), data: body, headers });

    if (r.status === 204 || r.data === undefined) {
      res.status(r.status).send();
      return;
    }

    console.log(r.status);
    console.log(r.data);

    if (typeof r.data === 'object' || typeof r.data === 'number' || typeof r.data === 'boolean') {
      res.status(r.status).json(r.data);
      return;
    }
    res.status(r.status).send(r.data);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async withActorLock<T>(actorType: string, actorId: string, fn: () => Promise<T>): Promise<T> {
    return this.actorLock.acquire(`${actorType}::${actorId}`, fn);
  }

  private appUrl(path: string): string {
    return `http://${this.options.appHost}:${this.options.appPort}${path}`;
  }

  private isShutdownError(err: unknown): boolean {
    if (this.stopping) return true;
    return /ECONNREFUSED|ECONNRESET|socket hang up|EPIPE|ETIMEDOUT/i.test((err as any)?.message ?? String(err));
  }

  /**
   * Build options from environment variables, allocating random free ports for
   * any that are not already set.  Writes the chosen ports back to the process
   * environment so the Dapr SDK picks them up automatically.
   *
   * Variables read / written:
   *   DAPR_HTTP_PORT   – sidecar HTTP port  (default: random)
   *   DAPR_GRPC_PORT   – sidecar gRPC port  (default: random, emulator does not use it)
   *   DAPR_SERVER_PORT – app port            (default: random)
   *   DAPR_SERVER_HOST – app host            (default: 127.0.0.1)
   */
  static async fromEnvironment(): Promise<SidecarOptions> {
    if (!process.env.DAPR_HTTP_PORT) {
      process.env.DAPR_HTTP_PORT = String(await randomPort());
    }
    if (!process.env.DAPR_GRPC_PORT) {
      process.env.DAPR_GRPC_PORT = String(await randomPort());
    }
    if (!process.env.DAPR_SERVER_PORT) {
      process.env.DAPR_SERVER_PORT = String(await randomPort());
    }

    return {
      host: '127.0.0.1',
      port: parseInt(process.env.DAPR_HTTP_PORT),
      appHost: process.env.DAPR_SERVER_HOST ?? '127.0.0.1',
      appPort: parseInt(process.env.DAPR_SERVER_PORT),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function randomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const srv = require('net').createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as import('net').AddressInfo).port;
      srv.close((err: Error | undefined) => (err ? reject(err) : resolve(port)));
    });
    srv.once('error', reject);
  });
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function schedKey(actorType: string, actorId: string, name: string): string {
  return `${actorType}::${actorId}::${name}`;
}

function msg(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

function parseDuration(value?: string): number | undefined {
  if (!value) return undefined;
  const s = value.trim().toLowerCase();
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return parseInt(s, 10);

  let total = 0;
  for (const [, amount, unit] of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    const n = parseFloat(amount);
    if (unit === 'h') total += n * 3_600_000;
    else if (unit === 'm') total += n * 60_000;
    else if (unit === 's') total += n * 1_000;
    else if (unit === 'ms') total += n;
  }

  return Math.max(0, Math.round(total));
}

function topicMatches(pattern: string, topic: string): boolean {
  if (!pattern) return false;
  if (pattern === topic) return true;
  if (!pattern.includes('#') && !pattern.includes('+')) return false;

  const regex = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\#/g, '.*')
    .replace(/\\\+/g, '[^/]*');

  return new RegExp(`^${regex}$`).test(topic);
}

function resolveRoute(subscription: any): string | undefined {
  if (typeof subscription.route === 'string') return subscription.route;
  const routes = subscription.routes;
  if (typeof routes?.default === 'string') return routes.default;
  if (Array.isArray(routes?.rules) && routes.rules.length > 0) {
    const path = routes.rules[0]?.path;
    if (typeof path === 'string') return path;
  }
  return undefined;
}
