import http from 'node:http';

import { createStore } from './lib/store.ts';
import { createRestHandler } from './lib/rest.ts';
import { createGraphqlHandler } from './lib/graphql.ts';
import { createMcpHandler } from './lib/mcp.ts';
import { createGitModule } from './lib/git.ts';

// One store per module load, with one REST handler bound to it.
const store = createStore();
const viewerLogin = process.env.MAKEFUN_VIEWER_LOGIN ?? 'adaiversen';
const handleRest = createRestHandler(store, viewerLogin);
const handleGraphql = createGraphqlHandler(store, viewerLogin, handleRest);
const handleMcp = createMcpHandler(store, viewerLogin, handleRest);

// One git handler bound to the same store, viewer login, and shared state that
// holds pushed tags (a tag is pushed after its repository already exists). The
// REST handler exposes the per-branch file map next to the object store, and a
// push that moves a branch tip refreshes that branch's map so the REST/GraphQL
// views of its files agree with the git objects.
const sharedState = { refs: new Map() };
const handleGit = createGitModule(
  store,
  () => handleRest.objects,
  () => handleRest.branchFiles,
  viewerLogin,
  sharedState,
).handle;

const API_PREFIX = '/api/v3';

function newRequestId(): string {
  return `${Date.now().toString(16)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Reads the raw request body as bytes. Git smart HTTP request and response
// bodies are binary pack data, so they must never pass through the text
// decoder used by the JSON surfaces.
function readBodyRaw(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function lowerHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'X-GitHub-Request-Id': requestId,
  });
  res.end(payload);
}

export function createApp(): http.Server {
  return http.createServer((req, res) => {
    const requestId = newRequestId();

    void (async () => {
      try {
        // git smart HTTP surface: GET /<owner>/<name>.git/info/refs and
        // POST /<owner>/<name>.git/git-upload-pack. The request and response
        // bodies are binary, so the raw body bytes are passed to the handler
        // and the handler's binary body is written back unchanged.
        const gitUrl = new URL(req.url ?? '/', 'http://localhost');
        const gitPath = gitUrl.pathname;

        // receive-pack (push): the v0 ref advertisement is served on
        // GET /<owner>/<name>.git/info/refs?service=git-receive-pack and the
        // push itself is POST /<owner>/<name>.git/git-receive-pack. The request
        // and response bodies are binary, so the raw body bytes are passed to
        // the handler and its binary body is written back unchanged.
        if (
          gitUrl.searchParams.get('service') === 'git-receive-pack' &&
          /^\/[^/]+\/[^/]+\.git\/info\/refs$/.test(gitPath)
        ) {
          const gitResult = await handleGit({
            method: (req.method ?? 'GET').toUpperCase(),
            headers: lowerHeaders(req.headers),
            body: await readBodyRaw(req),
            segments: gitPath.split('/').filter(Boolean),
            query: { service: 'git-receive-pack' },
          });
          const gitRespHeaders: Record<string, string | number> = {};
          for (const [key, value] of Object.entries(gitResult.headers ?? {})) {
            const lower = key.toLowerCase();
            if (lower === 'content-length') continue;
            gitRespHeaders[key] = value as string | number;
          }
          gitRespHeaders['Content-Length'] = Buffer.byteLength(gitResult.body);
          res.writeHead(gitResult.status, gitRespHeaders);
          res.end(gitResult.body);
          return;
        }
        if (
          (req.method ?? 'GET').toUpperCase() === 'POST' &&
          /^\/[^/]+\/[^/]+\.git\/git-receive-pack$/.test(gitPath)
        ) {
          const gitResult = await handleGit({
            method: 'POST',
            headers: lowerHeaders(req.headers),
            body: await readBodyRaw(req),
            segments: gitPath.split('/').filter(Boolean),
          });
          const gitRespHeaders: Record<string, string | number> = {};
          for (const [key, value] of Object.entries(gitResult.headers ?? {})) {
            const lower = key.toLowerCase();
            if (lower === 'content-length') continue;
            gitRespHeaders[key] = value as string | number;
          }
          gitRespHeaders['Content-Length'] = Buffer.byteLength(gitResult.body);
          res.writeHead(gitResult.status, gitRespHeaders);
          res.end(gitResult.body);
          return;
        }

        if (/^\/[^/]+\/[^/]+\.git\/(info\/refs|git-upload-pack)$/.test(gitPath)) {
          const gitResult = await handleGit({
            method: (req.method ?? 'GET').toUpperCase(),
            headers: lowerHeaders(req.headers),
            body: await readBodyRaw(req),
            segments: gitPath.split('/').filter(Boolean),
          });

          const gitRespHeaders: Record<string, string | number> = {};
          for (const [key, value] of Object.entries(gitResult.headers ?? {})) {
            const lower = key.toLowerCase();
            if (lower === 'content-length') continue;
            gitRespHeaders[key] = value as string | number;
          }
          gitRespHeaders['Content-Length'] = Buffer.byteLength(gitResult.body);
          res.writeHead(gitResult.status, gitRespHeaders);
          res.end(gitResult.body);
          return;
        }

        const bodyText = await readBody(req);
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = (req.method ?? 'GET').toUpperCase();
        const pathname = url.pathname;

        const query: Record<string, string> = {};
        for (const [key, value] of url.searchParams) {
          query[key] = value;
        }
        const headers = lowerHeaders(req.headers);

        if (method === 'GET' && pathname === '/healthz') {
          writeJson(res, 200, { ok: true }, requestId);
          return;
        }

        // GraphQL v4 surface: POST /api/graphql.
        if (method === 'POST' && pathname === '/api/graphql') {
          const segments = pathname
            .split('/')
            .filter(Boolean);
          const result = await handleGraphql({ method, headers, body: bodyText, segments });

          if (result === null) {
            writeJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }

          const respHeaders: Record<string, string | number> = {};
          for (const [key, value] of Object.entries(result.headers ?? {})) {
            const lower = key.toLowerCase();
            if (lower === 'content-length') continue;
            respHeaders[key] = value as string | number;
          }
          const payload =
            typeof result.body === 'string'
              ? result.body
              : JSON.stringify(result.body);
          respHeaders['Content-Length'] = Buffer.byteLength(payload);
          res.writeHead(result.status, respHeaders);
          res.end(payload);
          return;
        }

        // MCP surface: POST /mcp (JSON-RPC 2.0 over HTTP).
        if (method === 'POST' && pathname === '/mcp') {
          const result = await handleMcp({ method, headers, body: bodyText });

          if (result === null) {
            writeJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }

          const respHeaders: Record<string, string | number> = {};
          for (const [key, value] of Object.entries(result.headers ?? {})) {
            const lower = key.toLowerCase();
            if (lower === 'content-length') continue;
            respHeaders[key] = value as string | number;
          }
          const payload =
            typeof result.body === 'string'
              ? result.body
              : JSON.stringify(result.body);
          respHeaders['Content-Length'] = Buffer.byteLength(payload);
          res.writeHead(result.status, respHeaders);
          res.end(payload);
          return;
        }

        if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) {
          const segments = pathname
            .split('/')
            .filter(Boolean);
          const result = await handleRest({ store, viewer: viewerLogin, method, segments, query: url.searchParams, headers, body: bodyText });

          if (result === null) {
            writeJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }

          const respHeaders: Record<string, string | number> = {};
          for (const [key, value] of Object.entries(result.headers ?? {})) {
            const lower = key.toLowerCase();
            if (lower === 'content-type' || lower === 'x-github-request-id') continue;
            respHeaders[key] = value as string | number;
          }
          respHeaders['Content-Type'] = 'application/json';
          respHeaders['X-GitHub-Request-Id'] = requestId;

          const payload =
            typeof result.body === 'string'
              ? result.body
              : JSON.stringify(result.body);

          res.writeHead(result.status, respHeaders);
          res.end(payload);
          return;
        }

        writeJson(res, 404, { message: 'Not Found' }, requestId);
      } catch (err) {
        console.error('[app] error handling request:', err);
        if (!res.headersSent) {
          writeJson(res, 500, { message: 'Internal Server Error' }, requestId);
        } else {
          res.end();
        }
      }
    })();
  });
}


