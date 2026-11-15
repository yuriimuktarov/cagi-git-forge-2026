import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const MAIN = 'main.ts';
const STARTUP_TIMEOUT_MS = 20_000;
const CHILD_TIMEOUT_MS = 25_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRequestBody(req, cap = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > cap) {
        reject(new Error('request body exceeded cap'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
  });
  res.end(body);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  });
}

async function startEnvServer(handler) {
  const state = {
    registerCalls: 0,
    doneCalls: 0,
    registeredPort: null,
    handlerErrors: [],
  };

  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(() => handler(req, res, state))
      .catch((error) => {
        state.handlerErrors.push(error);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain' });
        }
        res.end('handler error');
      });
  });

  const address = await listen(server);
  return {
    state,
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5_000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('client request timed out')));
    req.on('error', reject);
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(
    `timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`,
  );
}

function spawnMain(env, t) {
  const supportsStripTypes =
    process.features && process.features.typescript !== undefined
      ? Boolean(process.features.typescript)
      : Number(process.versions.node.split('.')[0]) > 22;
  const args = supportsStripTypes
    ? [MAIN]
    : ['--experimental-strip-types', MAIN];

  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  });

  return {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

test(
  'A: registers a dynamic port, polls done false then true, exits 0',
  { timeout: CHILD_TIMEOUT_MS + 5_000 },
  async (t) => {
    const envServer = await startEnvServer(async (req, res, state) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/register') {
        state.registerCalls += 1;
        const raw = await readRequestBody(req);
        const payload = JSON.parse(raw);
        assert.equal(typeof payload, 'object');
        assert.notEqual(payload, null);
        assert.equal(typeof payload.port, 'number');
        assert.ok(Number.isInteger(payload.port));
        assert.ok(payload.port > 0 && payload.port <= 65_535);
        assert.notEqual(payload.port, 8080);
        state.registeredPort = payload.port;
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/done') {
        state.doneCalls += 1;
        const done = state.healthVerified === true && state.doneCalls > 2;
        sendJson(res, 200, { done });
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    });
    t.after(() => envServer.close());

    const env = {
      ...process.env,
      MAKEFUN_ENV_URL: envServer.url,
      MAKEFUN_REGISTER_TIMEOUT_MS: '8000',
      MAKEFUN_DONE_TIMEOUT_MS: '8000',
      MAKEFUN_REQUEST_TIMEOUT_MS: '2000',
    };

    const run = spawnMain(env, t);
    let exit;
    try {
      const port = await waitFor(
        () => envServer.state.registeredPort,
        STARTUP_TIMEOUT_MS,
        'POST /register from main.ts',
      );
      assert.notEqual(port, 8080);
      assert.equal(envServer.state.registerCalls, 1);

      const health = await waitFor(
        async () => {
          const response = await requestJson(`http://127.0.0.1:${port}/healthz`);
          return response.status === 200 ? response : null;
        },
        8_000,
        'health endpoint on registered port',
      );
      assert.deepEqual(JSON.parse(health.body), { ok: true });

      envServer.state.healthVerified = true;
      exit = await waitForExit(run.child, CHILD_TIMEOUT_MS);
    } catch (error) {
      run.child.kill();
      throw error;
    }

    assert.deepEqual(envServer.state.handlerErrors, []);
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    assert.equal(typeof envServer.state.registeredPort, 'number');
    assert.ok(envServer.state.doneCalls >= 3);
    assert.ok(envServer.state.registeredPort !== 8080);
  },
);

test(
  'B: HTTP 409 on /register is accepted and lifecycle completes',
  { timeout: CHILD_TIMEOUT_MS + 5_000 },
  async (t) => {
    const envServer = await startEnvServer(async (req, res, state) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/register') {
        state.registerCalls += 1;
        const raw = await readRequestBody(req);
        const payload = JSON.parse(raw);
        assert.equal(typeof payload.port, 'number');
        assert.ok(Number.isInteger(payload.port));
        assert.ok(payload.port > 0 && payload.port <= 65_535);
        state.registeredPort = payload.port;
        sendJson(res, 409, { error: 'already registered' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/done') {
        state.doneCalls += 1;
        sendJson(res, 200, { done: true });
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    });
    t.after(() => envServer.close());

    const env = {
      ...process.env,
      MAKEFUN_ENV_URL: envServer.url,
      MAKEFUN_REGISTER_TIMEOUT_MS: '8000',
      MAKEFUN_DONE_TIMEOUT_MS: '8000',
      MAKEFUN_REQUEST_TIMEOUT_MS: '2000',
    };

    const run = spawnMain(env, t);
    let exit;
    try {
      exit = await waitForExit(run.child, CHILD_TIMEOUT_MS);
    } catch (error) {
      run.child.kill();
      throw error;
    }

    assert.deepEqual(envServer.state.handlerErrors, []);
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    assert.equal(envServer.state.registerCalls, 1);
    assert.ok(envServer.state.doneCalls >= 1);
    assert.equal(typeof envServer.state.registeredPort, 'number');
    assert.notEqual(envServer.state.registeredPort, 8080);
  },
);

test(
  'C: missing MAKEFUN_ENV_URL exits nonzero without binding a server',
  { timeout: 15_000 },
  async (t) => {
    const env = { ...process.env };
    delete env.MAKEFUN_ENV_URL;

    const run = spawnMain(env, t);
    const exit = await waitForExit(run.child, 10_000);

    assert.notEqual(exit.code, 0);
    assert.ok(
      !run.stdout.includes('[make.fun] listening'),
      'main.ts must not bind a server when MAKEFUN_ENV_URL is missing',
    );
    assert.ok(
      !run.stdout.includes('register-'),
      'no registration attempt should be logged without MAKEFUN_ENV_URL',
    );
  },
);
