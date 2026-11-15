// The starter's HTTP surface: a health probe, an API root, and now a GitHub-style REST v3 slice
// (repository creation, repository reads, and issues with lifecycle) over one shared in-memory
// store. Git smart HTTP, GraphQL v4 and the MCP endpoint are still ahead.
//
// app.ts is deliberately separate from main.ts: this is the server, the file you grow; main.ts is the
// entry <-> env lifecycle and should stay as it is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Collect one request body as text; never rejects (the handler decides what a bad body means). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(data));
  });
}

/** Parse a JSON object body, or null when the payload is absent or not a JSON object. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  if (text.trim() === '') return null;
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

// One authenticated identity: every valid credential acts as this user, so behavior stays
// deterministic no matter which token a client sends.
const USER = { login: 'forge-user', id: 1, type: 'User', site_admin: false } as const;

// Fixed base instant; resource timestamps are derived from deterministic ids, never the wall clock.
const EPOCH_MS = Date.parse('2026-01-01T00:00:00Z');

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  labels: string[];
}

interface Repo {
  id: number;
  name: string;
  description: string | null;
  private: boolean;
  created_at: string;
  updated_at: string;
  issueSeq: number;
  issues: Map<number, Issue>;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  // Shared state for every endpoint of this app instance; one createApp() is one world.
  const repos = new Map<string, Repo>();
  let repoSeq = 0;
  let issueSeq = 0;

  const timeOf = (id: number): string => new Date(EPOCH_MS + id * 1000).toISOString();

  function repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      name: repo.name,
      full_name: `${USER.login}/${repo.name}`,
      owner: USER,
      private: repo.private,
      description: repo.description,
      created_at: repo.created_at,
      updated_at: repo.updated_at,
      default_branch: 'main',
      url: `/api/v3/repos/${USER.login}/${repo.name}`,
      issues_url: `/api/v3/repos/${USER.login}/${repo.name}/issues{/number}`,
    };
  }

  function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    const base = `/api/v3/repos/${USER.login}/${repo.name}`;
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      user: USER,
      labels: issue.labels,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      closed_at: issue.closed_at,
      comments: 0,
      url: `${base}/issues/${issue.number}`,
      repository_url: `${base}`,
    };
  }

  function findRepo(owner: string, name: string): Repo | undefined {
    // Only the one authenticated identity can own repos here, so a foreign owner simply misses.
    if (owner.toLowerCase() !== USER.login) return undefined;
    return repos.get(name.toLowerCase());
  }

  function authed(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    return header.trim().length > 0;
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, seg: string[]): Promise<void> {
    const method = req.method ?? 'GET';

    // POST /api/v3/user/repos — create a repository owned by the authenticated user.
    if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos' && method === 'POST') {
      if (!authed(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const body = parseJsonObject(await readBody(req));
      if (body === null) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const name = typeof body.name === 'string' ? body.name : '';
      if (name.length === 0) {
        sendJson(res, 422, {
          message: 'Validation Failed',
          errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }],
        });
        return;
      }
      const key = name.toLowerCase();
      if (repos.has(key)) {
        sendJson(res, 422, { message: 'name already exists on this account' });
        return;
      }
      repoSeq += 1;
      const repo: Repo = {
        id: repoSeq,
        name,
        description: typeof body.description === 'string' ? body.description : null,
        private: body.private === true,
        created_at: timeOf(repoSeq),
        updated_at: timeOf(repoSeq),
        issueSeq: 0,
        issues: new Map(),
      };
      repos.set(key, repo);
      sendJson(res, 201, repoJson(repo));
      return;
    }

    // GET /api/v3/repos/:owner/:repo — read one repository.
    if (seg.length === 3 && seg[0] === 'repos' && method === 'GET') {
      const repo = findRepo(seg[1], seg[2]);
      if (repo === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 200, repoJson(repo));
      return;
    }

    // /api/v3/repos/:owner/:repo/issues — create (POST) and list (GET).
    if (seg.length === 3 && seg[0] === 'repos' && seg[2] === 'issues') {
      const repo = findRepo(seg[1], seg[2]);
      if (repo === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      if (method === 'POST') {
        if (!authed(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const body = parseJsonObject(await readBody(req));
        if (body === null) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const title = typeof body.title === 'string' ? body.title : '';
        if (title.length === 0) {
          sendJson(res, 422, {
            message: 'Validation Failed',
            errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }],
          });
          return;
        }
        repo.issueSeq += 1;
        issueSeq += 1;
        const now = timeOf(issueSeq);
        const issue: Issue = {
          id: issueSeq,
          number: repo.issueSeq,
          title,
          body: typeof body.body === 'string' ? body.body : null,
          state: 'open',
          created_at: now,
          updated_at: now,
          closed_at: null,
          labels: Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [],
        };
        repo.issues.set(issue.number, issue);
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }

      if (method === 'GET') {
        const url = new URL(req.url ?? '/', 'http://entry');
        const state = url.searchParams.get('state') ?? 'open';
        if (state !== 'open' && state !== 'closed' && state !== 'all') {
          sendJson(res, 400, { message: 'Validation Failed' });
          return;
        }
        const listed = [...repo.issues.values()]
          .filter((issue) => state === 'all' || issue.state === state)
          .sort((a, b) => b.number - a.number)
          .map((issue) => issueJson(repo, issue));
        sendJson(res, 200, listed);
        return;
      }
    }

    // GET / PATCH /api/v3/repos/:owner/:repo/issues/:number — read one issue, close or edit it.
    if (seg.length === 4 && seg[0] === 'repos' && seg[2] === 'issues') {
      const repo = findRepo(seg[1], seg[2]);
      const number = Number(seg[3]);
      const issue = repo !== undefined && Number.isInteger(number) ? repo.issues.get(number) : undefined;
      if (repo === undefined || issue === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }

      if (method === 'PATCH') {
        if (!authed(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const body = parseJsonObject(await readBody(req));
        if (body === null) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        if (body.state !== undefined && body.state !== 'open' && body.state !== 'closed') {
          sendJson(res, 422, {
            message: 'Validation Failed',
            errors: [{ resource: 'Issue', field: 'state', code: 'invalid' }],
          });
          return;
        }
        if (typeof body.title === 'string' && body.title.length > 0) issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'closed' && issue.state === 'open') {
          issue.state = 'closed';
          issue.closed_at = timeOf(issue.id);
        } else if (body.state === 'open' && issue.state === 'closed') {
          issue.state = 'open';
          issue.closed_at = null;
        }
        issue.updated_at = timeOf(issue.id);
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
    }
  }

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // A deterministic health probe: 200 {"status":"ok"} on every call, no clock or env reads.
        if (method === 'GET' && path === '/health') {
          sendJson(res, 200, { status: 'ok' });
          return;
        }

        // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }

        // The REST v3 slice above; anything unter it that does not match is GitHub's 404.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const seg = path.slice('/api/v3'.length).split('/').filter((s) => s.length > 0);
          await handleApi(req, res, seg);
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        if (!res.headersSent) {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
