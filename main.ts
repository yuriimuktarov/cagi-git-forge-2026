import type { Server } from 'node:http';
import { createApp } from './app.ts';

const REGISTER_DEADLINE_MS = readBudget('MAKEFUN_REGISTER_TIMEOUT_MS', 60_000, 1_000, 600_000);
const DONE_DEADLINE_MS = readBudget('MAKEFUN_DONE_TIMEOUT_MS', 900_000, 1_000, 3_600_000);
const REQUEST_TIMEOUT_MS = readBudget('MAKEFUN_REQUEST_TIMEOUT_MS', 10_000, 100, 120_000);

const REGISTER_MAX_ATTEMPTS = 20;
const DONE_MAX_ATTEMPTS = 600;

const REGISTER_BACKOFF_START_MS = 100;
const REGISTER_BACKOFF_CEIL_MS = 2_000;
const POLL_INTERVAL_START_MS = 250;
const POLL_INTERVAL_CEIL_MS = 2_000;
const CLOSE_GRACE_MS = 5_000;

class FatalLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalLifecycleError';
  }
}

function readBudget(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function log(event: string, fields?: Record<string, unknown>): void {
  const suffix = fields === undefined ? '' : ` ${JSON.stringify(fields)}`;
  process.stdout.write(`[make.fun] ${event}${suffix}\n`);
}

function describeError(value: unknown): string {
  if (!(value instanceof Error)) return 'unknown';
  const cause = (value as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return `${value.name}:${code}`;
    return `${value.name}:${cause.name}`;
  }
  return value.name;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function requireEnvUrl(): URL {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw.trim() === '') {
    throw new FatalLifecycleError('MAKEFUN_ENV_URL is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new FatalLifecycleError('MAKEFUN_ENV_URL is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FatalLifecycleError('MAKEFUN_ENV_URL must use http or https');
  }
  if (parsed.hostname === '') {
    throw new FatalLifecycleError('MAKEFUN_ENV_URL must include a host');
  }
  return parsed;
}

function endpointFor(base: URL, route: string): string {
  const target = new URL(base.toString());
  const prefix = target.pathname.replace(/\/+$/, '');
  target.pathname = `${prefix}${route}`;
  target.search = '';
  target.hash = '';
  return target.toString();
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('request timed out'));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
    });
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function register(registerUrl: string, port: number): Promise<void> {
  const deadline = Date.now() + REGISTER_DEADLINE_MS;
  let delay = REGISTER_BACKOFF_START_MS;

  for (let attempt = 1; attempt <= REGISTER_MAX_ATTEMPTS; attempt += 1) {
    if (Date.now() >= deadline) {
      throw new FatalLifecycleError('registration deadline exceeded');
    }

    try {
      const response = await withTimeout((signal) =>
        fetch(registerUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ port }),
          signal,
        }),
      );

      const status = response.status;
      await response.text().catch(() => '');

      if (status === 200 || status === 409) {
        log('register-accepted', { attempt, status });
        return;
      }

      if (status === 400 || status === 405) {
        throw new FatalLifecycleError(`registration rejected with status ${status}`);
      }

      log('register-retry', { attempt, status });
    } catch (error) {
      if (error instanceof FatalLifecycleError) throw error;
      log('register-error', { attempt, error: describeError(error) });
      if (Date.now() >= deadline) {
        throw new FatalLifecycleError('registration deadline exceeded after error');
      }
    }

    await sleep(delay);
    delay = Math.min(delay * 2, REGISTER_BACKOFF_CEIL_MS);
  }

  throw new FatalLifecycleError('registration attempts exhausted');
}

async function waitForDone(doneUrl: string): Promise<void> {
  const deadline = Date.now() + DONE_DEADLINE_MS;
  let interval = POLL_INTERVAL_START_MS;

  for (let attempt = 1; attempt <= DONE_MAX_ATTEMPTS; attempt += 1) {
    if (Date.now() >= deadline) {
      throw new FatalLifecycleError('done deadline exceeded');
    }

    try {
      const response = await withTimeout((signal) =>
        fetch(doneUrl, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal,
        }),
      );

      if (response.status === 200) {
        const payload: unknown = await response.json().catch(() => null);
        if (
          payload !== null &&
          typeof payload === 'object' &&
          (payload as { done?: unknown }).done === true
        ) {
          log('done', { attempt });
          return;
        }
      } else {
        await response.text().catch(() => '');
      }

      log('done-poll', { attempt, status: response.status });
    } catch (error) {
      log('done-error', { attempt, error: describeError(error) });
      if (Date.now() >= deadline) {
        throw new FatalLifecycleError('done deadline exceeded after error');
      }
    }

    await sleep(interval);
    interval = Math.min(Math.floor(interval * 1.5), POLL_INTERVAL_CEIL_MS);
  }

  throw new FatalLifecycleError('done polling attempts exhausted');
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      resolve();
    };

    const grace = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, CLOSE_GRACE_MS);
    grace.unref();

    server.close(() => {
      clearTimeout(grace);
      finish();
    });
  });
}

async function main(): Promise<void> {
  const envUrl = requireEnvUrl();
  const registerUrl = endpointFor(envUrl, '/register');
  const doneUrl = endpointFor(envUrl, '/done');

  const server = createApp();
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await close(server);
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    log('signal', { signal });
    void shutdown().finally(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await listen(server);

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new FatalLifecycleError('server did not bind a TCP port');
    }

    const port = address.port;
    log('listening', { port });

    await register(registerUrl, port);
    await waitForDone(doneUrl);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await shutdown();
  }

  log('complete');
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    log('fatal', { error: describeError(error) });
    process.exit(1);
  },
);
