// lib/rest.ts
// GitHub core clone — REST surface.
// Session: auth, user/repos CRUD, repo metadata, branches, git refs.
// Commits and contents arrive in a later session.

import {
  sha1,
  buildBlob,
  buildTree,
  buildCommit,
  parseCommit,
  createObjectStore,
} from './objects.ts';

type Headers = Record<string, string>;

interface RestRequest {
  store: any;
  viewer: string;
  method: string;
  segments: string[];
  query: URLSearchParams;
  headers: Headers;
  body: string;
}

interface RestResponse {
  status: number;
  headers: Headers;
  body: string;
}

const PREFIX = ['api', 'v3'];
const ZERO_OID = '0000000000000000000000000000000000000000';

function requestId(): string {
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function makeResponse(status: number, headers: Headers, body: string): RestResponse {
  const h: Headers = {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': requestId(),
    ...headers,
  };
  return { status, headers: h, body };
}

function json(status: number, body: unknown, extra?: Headers): RestResponse {
  return makeResponse(status, { ...(extra || {}) }, JSON.stringify(body));
}

function text(status: number, body: string): RestResponse {
  return makeResponse(status, {}, body);
}

function err(status: number, message: string): RestResponse {
  return json(status, { message });
}

function ownerLogin(repo: any): string {
  if (typeof repo.owner === 'string') return repo.owner;
  if (repo.owner && typeof repo.owner.login === 'string') return repo.owner.login;
  return '';
}

function repoToObject(repo: any): any {
  const fullName = repo.full_name;
  const login = ownerLogin(repo);
  return {
    id: repo.id,
    node_id: 'R_' + Buffer.from(fullName, 'utf8').toString('base64url'),
    name: repo.name,
    full_name: fullName,
    owner: { login, id: 1000, type: 'User' },
    private: !!repo.private,
    description: repo.description === undefined || repo.description === null ? '' : repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    html_url: 'https://github.com/' + fullName,
    url: '/api/v3/repos/' + fullName,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: Array.isArray(repo.issues) ? repo.issues.length : 0,
    has_issues: true,
  };
}

function checkAuth(headers: Headers): boolean {
  const raw = (headers['authorization'] || '').trim();
  const m = /^Bearer\s+(\S+)$/i.exec(raw);
  if (!m) return false;
  const token = m[1];
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected && expected.length > 0) return token === expected;
  return token.length > 0;
}

function commitUrl(fullName: string, sha: string): string {
  return '/api/v3/repos/' + fullName + '/commits/' + sha;
}

const SEED_LABELS: Array<[string, string]> = [
  ['bug', 'd73a4a'],
  ['enhancement', 'a2eeef'],
  ['documentation', '0075ca'],
  ['question', 'd876e3'],
  ['good first issue', '7057ff'],
  ['help wanted', '008672'],
];

// Reconstruct a file map ({ path -> { content, oid } }) exactly as it was at
// the given commit, by walking the commit's tree in the git object store.
function filesAtCommit(objects: any, oid: string): Map<string, { content: string; oid: string }> | undefined {
  const commit = objects.get(oid);
  if (!commit || commit.type !== 'commit') return undefined;
  const treeOid = parseCommit(commit.raw).tree;
  const out = new Map<string, { content: string; oid: string }>();
  function walk(treeId: string, prefix: string): void {
    const treeObj = objects.get(treeId);
    if (!treeObj || treeObj.type !== 'tree') return;
    const raw = Buffer.isBuffer(treeObj.raw) ? treeObj.raw : Buffer.from(treeObj.raw.data || treeObj.raw);
    let pos = 0;
    while (pos < raw.length && raw[pos] !== 0) pos++;
    pos++; // skip "tree <size>\0" header
    while (pos < raw.length) {
      let nul = pos;
      while (nul < raw.length && raw[nul] !== 0) nul++;
      const entry = raw.slice(pos, nul).toString('utf8');
      pos = nul + 1;
      const oidBytes = raw.slice(pos, pos + 20);
      pos += 20;
      const space = entry.indexOf(' ');
      const mode = entry.slice(0, space);
      const name = entry.slice(space + 1);
      const oidHex = oidBytes.toString('hex');
      const path = prefix ? prefix + '/' + name : name;
      if (mode === '100644' || mode === '100755') {
        const b = objects.get(oidHex);
        if (b && b.type === 'blob') {
          const buf = Buffer.isBuffer(b.raw) ? b.raw : Buffer.from(b.raw.data || b.raw);
          const headerEnd = buf.indexOf(0);
          const content = (headerEnd >= 0 ? buf.slice(headerEnd + 1) : buf).toString('utf8');
          out.set(path, { content, oid: oidHex });
        }
      } else if (mode === '040000') {
        walk(oidHex, path);
      }
    }
  }
  walk(treeOid, '');
  return out;
}

export function createRestHandler(store: any, viewerLogin?: string) {
  const resolvedViewer = viewerLogin || process.env.MAKEFUN_VIEWER_LOGIN || 'adaiversen';

  // Per-branch file/commit state, keyed "owner/name:branch".
  const branchFiles = new Map<string, Map<string, { content: string; oid: string }>>();
  const branchCommits = new Map<string, string[]>();
  // Snapshot of a branch's files as they were at creation time, kept as a
  // separate copy from the branch's live file map. Used by the three-way
  // merge conflict check.
  const branchSnapshots = new Map<string, Map<string, { content: string; oid: string }>>();

  // Git object store shared by every request, plus commit-recording helpers.
  const objects = createObjectStore();

  function commitResponse(fullName: string, oid: string): any | null {
    const stored = objects.get(oid);
    if (!stored || stored.type !== 'commit') return null;
    const parsed = parseCommit(stored.raw);
    const dateOf = (p: { epoch: number }): string => new Date(p.epoch * 1000).toISOString();
    return {
      sha: oid,
      commit: {
        message: parsed.message,
        author: { name: parsed.author.name, email: parsed.author.email, date: dateOf(parsed.author) },
        committer: { name: parsed.committer.name, email: parsed.committer.email, date: dateOf(parsed.committer) },
      },
      parents: parsed.parents.map((p: string) => ({ sha: p })),
      url: commitUrl(fullName, oid),
    };
  }

  function ensureBranch(repo: any, branch: string): Map<string, { content: string; oid: string }> {
    const key = branchKey(repo.full_name, branch);
    let map = branchFiles.get(key);
    if (!map) {
      map = new Map<string, { content: string; oid: string }>();
      branchFiles.set(key, map);
    }
    if (!branchCommits.has(key)) branchCommits.set(key, []);
    return map;
  }

  // Record a commit on `branch` from its current file map; returns the new oid.
  function recordCommit(repo: any, branch: string, message: string, authorLogin: string): string {
    const map = ensureBranch(repo, branch);
    const key = branchKey(repo.full_name, branch);
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    for (const [name, file] of map) {
      const blob = buildBlob(file.content);
      objects.put(blob.oid, { type: 'blob', raw: blob.raw });
      entries.push({ mode: '100644', name, oid: blob.oid });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const tree = buildTree(entries);
    objects.put(tree.oid, { type: 'tree', raw: tree.raw });
    const commits = branchCommits.get(key) as string[];
    const previousTip =
      (repo.branches && repo.branches.get ? repo.branches.get(branch) : undefined) ||
      (commits.length > 0 ? commits[0] : undefined);
    const person = { name: authorLogin, email: authorLogin + '@example.invalid', epoch: Math.floor(Date.now() / 1000) };
    const commit = buildCommit({
      tree: tree.oid,
      parents: previousTip ? [previousTip] : [],
      author: person,
      committer: person,
      message,
    });
    objects.put(commit.oid, { type: 'commit', raw: commit.raw });
    commits.unshift(commit.oid);
    if (repo.branches && typeof repo.branches.set === 'function') repo.branches.set(branch, commit.oid);
    syncDefaultBranchFiles(repo);
    return commit.oid;
  }

  function branchKey(fullName: string, branch: string): string {
    return fullName + ':' + branch;
  }

  function knownShas(repo: any): Set<string> {
    const s = new Set<string>([ZERO_OID]);
    if (repo && repo.branches && typeof repo.branches.forEach === 'function') {
      repo.branches.forEach((v: any) => {
        if (typeof v === 'string') s.add(v);
      });
    }
    if (repo && repo.files && typeof repo.files.forEach === 'function') {
      repo.files.forEach((f: any) => {
        if (f && typeof f.oid === 'string') s.add(f.oid);
      });
    }
    branchCommits.forEach((oids, key) => {
      if (key.startsWith(repo.full_name + ':')) oids.forEach((o) => s.add(o));
    });
    return s;
  }

  function syncDefaultBranchFiles(repo: any): void {
    const db = repo.default_branch;
    const map = branchFiles.get(branchKey(repo.full_name, db));
    if (map && repo.files && typeof repo.files.clear === 'function') {
      repo.files.clear();
      map.forEach((v, k) => repo.files.set(k, { content: v.content, oid: v.oid }));
    }
  }

  function seedLabels(repo: any): void {
    for (const [name, color] of SEED_LABELS) {
      if (store.createLabel) store.createLabel(repo, name, color);
    }
  }

  return async function handler(req: RestRequest): Promise<RestResponse | null> {
    const viewer = (req && req.viewer) || resolvedViewer;
    const method = ((req && req.method) || 'GET').toUpperCase();
    const segments = (req && req.segments) || [];
    const query = (req && req.query) || new URLSearchParams();
    const headers = (req && req.headers) || {};
    const bodyText = (req && req.body) || '';

    // Expose the shared git state to other surfaces built over the same store
    // (the GraphQL handler reads these back through `shared`). The handler is a
    // named function expression, so it is in scope here and carries the closure
    // state as properties.
    (handler as any).branchFiles = branchFiles;
    (handler as any).branchCommits = branchCommits;
    (handler as any).branchSnapshots = branchSnapshots;
    (handler as any).objects = objects;
    (handler as any).store = store;

    // Only the REST surface lives under /api/v3; anything else is not ours.
    if (segments.length < PREFIX.length || segments[0] !== PREFIX[0] || segments[1] !== PREFIX[1]) {
      return null;
    }
    const parts = segments.slice(PREFIX.length);

    // Every REST route requires an Authorization: Bearer <token> header.
    if (!checkAuth(headers)) {
      return err(401, 'Bad credentials');
    }

    const host = headers['host'] || 'localhost';

    function parseBody(): any | undefined {
      if (!bodyText || bodyText.trim() === '') return {};
      try {
        return JSON.parse(bodyText);
      } catch {
        return undefined;
      }
    }

    // GET /api/v3 — API root.
    if (method === 'GET' && parts.length === 0) {
      return json(
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'x-oauth-scopes': 'repo, read:org' }
      );
    }

    // GET /api/v3/meta.
    if (method === 'GET' && parts.length === 1 && parts[0] === 'meta') {
      return json(200, { installed_version: '0.0.0' });
    }

    // GET /api/v3/user/repos — viewer's repos, newest first, paginated.
    if (method === 'GET' && parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
      const perPage = parseInt(query.get('per_page') || '30', 10) || 30;
      const page = parseInt(query.get('page') || '1', 10) || 1;
      const raw = store.listRepos ? store.listRepos({ owner: viewer }) : [];
      const repos = Array.isArray(raw) ? [...raw] : [];
      repos.sort((a: any, b: any) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
      const start = (page - 1) * perPage;
      const slice = repos.slice(start, start + perPage);
      const extra: Headers = {};
      if (start + perPage < repos.length) {
        const next = 'http://' + host + '/api/v3/user/repos?per_page=' + perPage + '&page=' + (page + 1);
        extra['Link'] = '<' + next + '>; rel="next"';
      }
      return json(200, slice.map((r: any) => repoToObject(r)), extra);
    }

    // POST /api/v3/user/repos — create a repo under the viewer.
    if (method === 'POST' && parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
      const body = parseBody();
      if (body === undefined) return err(400, 'Invalid JSON');
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) return err(422, 'Repository name is required');
      const existing = store.getRepo ? store.getRepo(viewer, name) : undefined;
      if (existing) return err(422, 'Repository ' + name + ' already exists');
      const repo = store.createRepo(viewer, name, {
        description: typeof body.description === 'string' ? body.description : '',
        private: !!body.private,
        default_branch: typeof body.default_branch === 'string' ? body.default_branch : undefined,
      });
      seedLabels(repo);
      branchFiles.set(branchKey(repo.full_name, repo.default_branch), new Map());
      branchCommits.set(branchKey(repo.full_name, repo.default_branch), []);
      return json(201, repoToObject(repo));
    }

    // GET /api/v3/repos/owner/name.
    if (method === 'GET' && parts.length === 3 && parts[0] === 'repos') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      return json(200, repoToObject(repo));
    }

    // PATCH /api/v3/repos/owner/name — update description/private/default_branch.
    if (method === 'PATCH' && parts.length === 3 && parts[0] === 'repos') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const body = parseBody();
      if (body === undefined) return err(400, 'Invalid JSON');
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string') repo.default_branch = body.default_branch;
      repo.updated_at = new Date().toISOString();
      syncDefaultBranchFiles(repo);
      return json(200, repoToObject(repo));
    }

    // DELETE /api/v3/repos/owner/name — 204, no content.
    if (method === 'DELETE' && parts.length === 3 && parts[0] === 'repos') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const fn = repo.full_name;
      if (store.repos && typeof store.repos.delete === 'function') {
        store.repos.delete(fn);
      }
      for (const key of [...branchFiles.keys()]) {
        if (key.startsWith(fn + ':')) branchFiles.delete(key);
      }
      for (const key of [...branchCommits.keys()]) {
        if (key.startsWith(fn + ':')) branchCommits.delete(key);
      }
      for (const key of [...branchSnapshots.keys()]) {
        if (key.startsWith(fn + ':')) branchSnapshots.delete(key);
      }
      return text(204, '');
    }

    // GET /api/v3/repos/owner/name/branches.
    if (method === 'GET' && parts.length === 4 && parts[0] === 'repos' && parts[3] === 'branches') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const bm = repo.branches;
      const names: string[] = [];
      const seen = new Set<string>();
      if (bm && typeof bm.forEach === 'function') {
        bm.forEach((_v: any, k: string) => {
          if (!seen.has(k)) {
            seen.add(k);
            names.push(k);
          }
        });
      }
      if (repo.default_branch && !seen.has(repo.default_branch)) {
        seen.add(repo.default_branch);
        names.push(repo.default_branch);
      }
      const list = names.map((branch: string) => {
        const sha = (bm && bm.get ? bm.get(branch) : undefined) || ZERO_OID;
        return { name: branch, commit: { sha, url: commitUrl(repo.full_name, sha) } };
      });
      return json(200, list);
    }

    // POST /api/v3/repos/owner/name/git/refs.
    if (
      method === 'POST' &&
      parts.length === 5 &&
      parts[0] === 'repos' &&
      parts[3] === 'git' &&
      parts[4] === 'refs'
    ) {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const body = parseBody();
      if (body === undefined) return err(400, 'Invalid JSON');
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref || !sha) return err(422, 'ref and sha are required');
      const branch = ref.indexOf('refs/heads/') === 0 ? ref.slice('refs/heads/'.length) : '';
      if (!branch) return err(422, 'ref must be refs/heads/<branch>');
      if (!knownShas(repo).has(sha)) return err(422, 'sha not found');
      // Determine which branch owns `sha` BEFORE registering the new branch,
      // so the branch being created does not match itself.
      let sourceBranch = '';
      if (repo.branches && typeof repo.branches.forEach === 'function') {
        repo.branches.forEach((v: any, k: string) => {
          if (v === sha) sourceBranch = k;
        });
      }
      if (repo.branches && typeof repo.branches.set === 'function') repo.branches.set(branch, sha);
      const key = branchKey(repo.full_name, branch);
      if (!branchCommits.has(key)) branchCommits.set(key, []);
      const commits = branchCommits.get(key) as string[];
      if (!commits.includes(sha)) commits.unshift(sha);
      // Give the new branch the same files as the branch that owns `sha`.
      // Copy the map so later changes on one branch never leak into another.
      let sourceMap: Map<string, { content: string; oid: string }> | undefined;
      if (sourceBranch) {
        sourceMap = branchFiles.get(branchKey(repo.full_name, sourceBranch));
      } else {
        // No branch points at this commit: reconstruct the files exactly as
        // they were at that commit from the git object store, falling back to
        // the default branch's files when the tree cannot be rebuilt.
        sourceMap = filesAtCommit(objects, sha);
        if (!sourceMap || sourceMap.size === 0) {
          sourceMap = branchFiles.get(branchKey(repo.full_name, repo.default_branch));
        }
      }
      if (sourceMap) {
        const copy = new Map<string, { content: string; oid: string }>();
        const snapshot = new Map<string, { content: string; oid: string }>();
        sourceMap.forEach((v, k) => {
          copy.set(k, { content: v.content, oid: v.oid });
          snapshot.set(k, { content: v.content, oid: v.oid });
        });
        branchFiles.set(key, copy);
        branchSnapshots.set(key, snapshot);
      }
      return json(201, { ref, object: { sha, type: 'commit' } });
    }

    // GET /api/v3/repos/owner/name/git/refs/heads/branch.
    if (
      method === 'GET' &&
      parts.length === 7 &&
      parts[0] === 'repos' &&
      parts[3] === 'git' &&
      parts[4] === 'refs' &&
      parts[5] === 'heads'
    ) {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const branch = parts[6];
      let sha = repo.branches && repo.branches.get ? repo.branches.get(branch) : undefined;
      if (sha === undefined && branch === repo.default_branch) sha = ZERO_OID;
      if (!sha) return err(404, 'Not Found');
      return json(200, { ref: 'refs/heads/' + branch, object: { sha, type: 'commit' } });
    }

    // GET /api/v3/repos/owner/name/commits?sha=branch — commits for a branch, newest first.
    if (method === 'GET' && parts.length === 4 && parts[0] === 'repos' && parts[3] === 'commits') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const branch = query.get('sha') || repo.default_branch;
      const oids = branchCommits.get(branchKey(repo.full_name, branch)) || [];
      return json(
        200,
        oids
          .map((oid: string) => commitResponse(repo.full_name, oid))
          .filter((c: any) => c !== null)
      );
    }

    // GET /api/v3/repos/owner/name/commits/oid — one commit.
    if (method === 'GET' && parts.length === 5 && parts[0] === 'repos' && parts[3] === 'commits') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const answer = commitResponse(repo.full_name, parts[4]);
      if (!answer) return err(404, 'Not Found');
      return json(200, answer);
    }

    // PUT /api/v3/repos/owner/name/contents/<path> — create or update a file.
    if (method === 'PUT' && parts.length >= 5 && parts[0] === 'repos' && parts[3] === 'contents') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const body = parseBody();
      if (body === undefined) return err(400, 'Invalid JSON');
      if (typeof body.message !== 'string' || typeof body.content !== 'string') {
        return err(422, 'message and content are required');
      }
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
      const path = parts.slice(4).join('/');
      const map = ensureBranch(repo, branch);
      const current = map.get(path);
      if (typeof body.sha === 'string' && body.sha !== '' && (!current || current.oid !== body.sha)) {
        return err(409, 'sha does not match');
      }
      const contentBuf = Buffer.from(body.content, 'base64');
      const content = contentBuf.toString('utf8');
      const blob = buildBlob(contentBuf);
      objects.put(blob.oid, { type: 'blob', raw: blob.raw });
      map.set(path, { content, oid: blob.oid });
      const commitOid = recordCommit(repo, branch, body.message, viewer);
      return json(201, {
        content: {
          name: path.split('/').pop() as string,
          path,
          sha: blob.oid,
          type: 'file',
          content: contentBuf.toString('base64'),
          encoding: 'base64',
        },
        commit: { sha: commitOid, message: body.message },
      });
    }

    // GET /api/v3/repos/owner/name/contents/<path> — a file or the direct children of a directory.
    if (method === 'GET' && parts.length >= 5 && parts[0] === 'repos' && parts[3] === 'contents') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const branch = query.get('ref') || repo.default_branch;
      const map = branchFiles.get(branchKey(repo.full_name, branch));
      if (!map) return err(404, 'Not Found');
      const path = parts.slice(4).join('/');
      const file = map.get(path);
      if (file) {
        const contentBuf = Buffer.from(file.content, 'utf8');
        return json(200, {
          type: 'file',
          name: path.split('/').pop() as string,
          path,
          sha: file.oid,
          size: contentBuf.length,
          content: contentBuf.toString('base64'),
          encoding: 'base64',
        });
      }
      const prefix = path + '/';
      const children: Array<{ type: string; name: string; path: string; sha: string }> = [];
      const seen = new Set<string>();
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const seg = rest.split('/')[0];
          if (!seg || seen.has(seg)) continue;
          seen.add(seg);
          const childPath = prefix + seg;
          if (map.has(childPath)) {
            children.push({ type: 'file', name: seg, path: childPath, sha: (map.get(childPath) as any).oid });
          } else {
            const under: string[] = [];
            for (const k of map.keys()) if (k.startsWith(childPath + '/')) under.push(k);
            under.sort();
            children.push({ type: 'dir', name: seg, path: childPath, sha: sha1(Buffer.from(under.join('\n'), 'utf8')) });
          }
        }
      }
      if (children.length === 0) return err(404, 'Not Found');
      children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return json(200, children);
    }

    // DELETE /api/v3/repos/owner/name/contents/<path> — remove a file.
    if (method === 'DELETE' && parts.length >= 5 && parts[0] === 'repos' && parts[3] === 'contents') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const body = parseBody();
      if (body === undefined) return err(400, 'Invalid JSON');
      if (typeof body.message !== 'string') return err(422, 'message is required');
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
      const path = parts.slice(4).join('/');
      const map = branchFiles.get(branchKey(repo.full_name, branch));
      const current = map ? map.get(path) : undefined;
      if (!current) return err(404, 'Not Found');
      if (typeof body.sha === 'string' && body.sha !== '' && current.oid !== body.sha) {
        return err(409, 'sha does not match');
      }
      (map as Map<string, { content: string; oid: string }>).delete(path);
      const commitOid = recordCommit(repo, branch, body.message, viewer);
      return json(200, {
        sha: commitOid,
        message: body.message,
        commit: { sha: commitOid, message: body.message },
      });
    }

    // POST /api/v3/repos/owner/name/issues — create an issue.
    if (method === 'POST' && parts.length === 4 && parts[0] === 'repos' && parts[3] === 'issues') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const body = parseBody();
      if (body === undefined) return err(400, 'Invalid JSON');
      if (typeof body.title !== 'string' || body.title.trim() === '') return err(422, 'Body: title is required');
      const labelNames = normalizeLabelNames(body.labels);
      const missing = labelNames.find((nm: string) => !labelExists(repo, nm));
      if (missing) return err(422, 'Label ' + missing + ' does not exist');
      const issue = callCreateIssue(store, repo, {
        title: body.title,
        body: body.body,
        labels: labelNames,
        user: viewer,
      });
      return json(201, issueObject(repo, issue));
    }

    // GET /api/v3/repos/owner/name/issues — list issues filtered by state.
    if (method === 'GET' && parts.length === 4 && parts[0] === 'repos' && parts[3] === 'issues') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const state = query.get('state') || 'open';
      const direction = query.get('direction') || 'desc';
      const issues = callListIssues(store, repo, { state }).slice().sort((a: any, b: any) => {
        const cmp = String(a.created_at || '').localeCompare(String(b.created_at || ''));
        return direction === 'asc' ? cmp : -cmp;
      });
      return json(200, issues.map((i: any) => issueObject(repo, i)));
    }

    // GET /api/v3/repos/owner/name/issues/number — one issue.
    if (method === 'GET' && parts.length === 5 && parts[0] === 'repos' && parts[3] === 'issues') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const issue = callGetIssue(store, repo, parseInt(parts[4], 10));
      if (!issue) return err(404, 'Not Found');
      return json(200, issueObject(repo, issue));
    }

    // PATCH /api/v3/repos/owner/name/issues/number — update an issue.
    if (method === 'PATCH' && parts.length === 5 && parts[0] === 'repos' && parts[3] === 'issues') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const body = parseBody();
      if (body === undefined) return err(400, 'Invalid JSON');
      const n = parseInt(parts[4], 10);
      const issue = callGetIssue(store, repo, n);
      if (!issue) return err(404, 'Not Found');
      const fields: any = {};
      if (typeof body.state === 'string') fields.state = body.state;
      if (typeof body.title === 'string') fields.title = body.title;
      if (typeof body.body === 'string') fields.body = body.body;
      if (body.labels !== undefined) {
        const labelNames = normalizeLabelNames(body.labels);
        const missing = labelNames.find((nm: string) => !labelExists(repo, nm));
        if (missing) return err(422, 'Label ' + missing + ' does not exist');
        fields.labels = labelNames;
      }
      callUpdateIssue(store, repo, n, fields);
      const updated = callGetIssue(store, repo, n) || issue;
      return json(200, issueObject(repo, updated));
    }

    // POST /api/v3/repos/owner/name/issues/number/comments — add a comment.
    if (
      method === 'POST' &&
      parts.length === 6 &&
      parts[0] === 'repos' &&
      parts[3] === 'issues' &&
      parts[5] === 'comments'
    ) {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const n = parseInt(parts[4], 10);
      const issue = callGetIssue(store, repo, n);
      if (!issue) return err(404, 'Not Found');
      const body = parseBody();
      if (body === undefined) return err(400, 'Invalid JSON');
      if (typeof body.body !== 'string' || body.body.trim() === '') return err(422, 'Body: body is required');
      const comment = callCreateComment(store, repo, n, body.body, viewer);
      return json(201, commentObject(comment));
    }

    // GET /api/v3/repos/owner/name/issues/number/comments — list comments.
    if (
      method === 'GET' &&
      parts.length === 6 &&
      parts[0] === 'repos' &&
      parts[3] === 'issues' &&
      parts[5] === 'comments'
    ) {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const n = parseInt(parts[4], 10);
      const issue = callGetIssue(store, repo, n);
      if (!issue) return err(404, 'Not Found');
      const comments = callListComments(store, repo, n);
      return json(200, comments.map((c: any) => commentObject(c)));
    }

    // GET /api/v3/repos/owner/name/labels — list labels.
    if (method === 'GET' && parts.length === 4 && parts[0] === 'repos' && parts[3] === 'labels') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const labels = callListLabels(store, repo);
      return json(200, labels.map((l: any) => labelObject(l)));
    }

    // POST /api/v3/repos/owner/name/labels — create a label.
    if (method === 'POST' && parts.length === 4 && parts[0] === 'repos' && parts[3] === 'labels') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const body = parseBody();
      if (body === undefined) return err(400, 'Invalid JSON');
      if (
        typeof body.name !== 'string' ||
        body.name.trim() === '' ||
        typeof body.color !== 'string' ||
        body.color.trim() === ''
      ) {
        return err(422, 'name and color are required');
      }
      const label = callCreateLabel(store, repo, body.name, body.color);
      return json(201, labelObject(label));
    }

    // POST /api/v3/repos/owner/name/pulls — create a pull request.
    if (method === 'POST' && parts.length === 4 && parts[0] === 'repos' && parts[3] === 'pulls') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const body = parseBody();
      if (body === undefined) return err(400, 'Invalid JSON');
      if (typeof body.title !== 'string' || body.title.trim() === '') return err(422, 'Body: title is required');
      const headRef = typeof body.head === 'string' ? body.head : body.head && body.head.ref;
      const baseRef = typeof body.base === 'string' ? body.base : body.base && body.base.ref;
      if (!headRef || !baseRef) return err(422, 'head and base are required');
      const headSha = repo.branches && repo.branches.get ? repo.branches.get(headRef) : undefined;
      const baseSha = repo.branches && repo.branches.get ? repo.branches.get(baseRef) : undefined;
      if (!headSha) return err(422, 'head branch ' + headRef + ' does not exist');
      if (!baseSha && baseRef !== repo.default_branch) return err(422, 'base branch ' + baseRef + ' does not exist');
      const pull = callCreatePull(store, repo, {
        title: body.title,
        body: body.body,
        head: headRef,
        base: baseRef,
        user: viewer,
      });
      return json(201, pullObject(repo, pull));
    }

    // GET /api/v3/repos/owner/name/pulls — list pulls filtered by state.
    if (method === 'GET' && parts.length === 4 && parts[0] === 'repos' && parts[3] === 'pulls') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const state = query.get('state') || 'open';
      const pulls = callListPulls(store, repo, { state });
      return json(200, pulls.map((p: any) => pullObject(repo, p)));
    }

    // GET /api/v3/repos/owner/name/pulls/number — one pull.
    if (method === 'GET' && parts.length === 5 && parts[0] === 'repos' && parts[3] === 'pulls') {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const pull = callGetPull(store, repo, parseInt(parts[4], 10));
      if (!pull) return err(404, 'Not Found');
      return json(200, pullObject(repo, pull));
    }

    // GET /api/v3/repos/owner/name/pulls/number/files — changed files of a pull.
    if (
      method === 'GET' &&
      parts.length === 6 &&
      parts[0] === 'repos' &&
      parts[3] === 'pulls' &&
      parts[5] === 'files'
    ) {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const pull = callGetPull(store, repo, parseInt(parts[4], 10));
      if (!pull) return err(404, 'Not Found');
      const headRef = pullRef(pull.head);
      const baseRef = pullRef(pull.base);
      const headMap = branchFiles.get(branchKey(repo.full_name, headRef)) || new Map();
      const baseMap = branchFiles.get(branchKey(repo.full_name, baseRef)) || new Map();
      const paths = new Set<string>();
      headMap.forEach((_v: any, k: string) => paths.add(k));
      baseMap.forEach((_v: any, k: string) => paths.add(k));
      const list: any[] = [];
      for (const path of Array.from(paths).sort()) {
        const h = headMap.get(path);
        const b = baseMap.get(path);
        if (h && !b) {
          const add = countLines(h.content);
          list.push({ filename: path, status: 'added', additions: add, deletions: 0, changes: add });
        } else if (h && b && h.content !== b.content) {
          const d = countLineDiff(b.content, h.content);
          list.push({
            filename: path,
            status: 'modified',
            additions: d.additions,
            deletions: d.deletions,
            changes: d.additions + d.deletions,
          });
        } else if (!h && b) {
          const del = countLines(b.content);
          list.push({ filename: path, status: 'removed', additions: 0, deletions: del, changes: del });
        }
      }
      return json(200, list);
    }

    // PUT /api/v3/repos/owner/name/pulls/number/merge — merge a pull request.
    if (
      method === 'PUT' &&
      parts.length === 6 &&
      parts[0] === 'repos' &&
      parts[3] === 'pulls' &&
      parts[5] === 'merge'
    ) {
      const repo = store.getRepo ? store.getRepo(parts[1], parts[2]) : undefined;
      if (!repo) return err(404, 'Not Found');
      const n = parseInt(parts[4], 10);
      const pull = callGetPull(store, repo, n);
      if (!pull) return err(404, 'Not Found');
      const headRef = pullRef(pull.head);
      const baseRef = pullRef(pull.base);
      const headMap = branchFiles.get(branchKey(repo.full_name, headRef)) || new Map();
      const baseMap = ensureBranch(repo, baseRef);
      const headSnapshot = branchSnapshots.get(branchKey(repo.full_name, headRef));
      let conflict: string | null = null;
      if (headSnapshot) {
        // Three-way merge check against the state the head branch started from.
        for (const [path, f] of headMap) {
          const snap = headSnapshot.get(path);
          const bf = baseMap.get(path);
          if (snap && f.content === snap.content) continue; // head did not change the file
          if (snap && bf && bf.content === snap.content) continue; // base did not change the file
          if (!snap && !bf) continue; // head added it, base does not have it
          if (bf && bf.content === f.content) continue; // both changed it to the same version
          conflict = path;
          break;
        }
      } else {
        // No snapshot (branch created by another route): keep the old behaviour.
        for (const [path, f] of headMap) {
          const bf = baseMap.get(path);
          if (bf && bf.content !== f.content) {
            conflict = path;
            break;
          }
        }
      }
      if (conflict) return err(405, 'Merge conflict in ' + conflict);
      baseMap.clear();
      for (const [path, f] of headMap) {
        baseMap.set(path, { content: f.content, oid: f.oid });
      }
      const mergeOid = recordCommit(repo, baseRef, 'Merge pull request #' + n + ' from ' + headRef, viewer);
      callUpdatePull(store, repo, n, {
        state: 'closed',
        merged: true,
        merged_at: nowIso(),
        merge_commit_sha: mergeOid,
      });
      return json(200, { merged: true, sha: mergeOid, message: 'Pull Request successfully merged' });
    }

    // Unknown route under the /api/v3 prefix.
    return err(404, 'Not Found');
  };
}

// ---------------------------------------------------------------------------
// Issues, labels and pull requests: response builders and store wrappers.
// Appended by a later recorded session.
// ---------------------------------------------------------------------------

let __commentSeq = 0;

function nowIso(): string {
  return new Date().toISOString();
}

function asArray(v: any): any[] {
  return Array.isArray(v) ? v : [];
}

function userObject(u: any): { login: string; id: number } {
  let login = '';
  if (typeof u === 'string') login = u;
  else if (u && typeof u.login === 'string') login = u.login;
  else if (u && typeof u.name === 'string') login = u.name;
  return { login, id: 1000 };
}

function labelColor(repo: any, name: string): string {
  for (const l of asArray(repo.labels)) {
    if (l && typeof l.name === 'string' && l.name === name && typeof l.color === 'string') return l.color;
  }
  return 'ededed';
}

function labelExists(repo: any, name: string): boolean {
  return asArray(repo.labels).some((l: any) => l && typeof l.name === 'string' && l.name === name);
}

function normalizeLabelNames(labels: any): string[] {
  const out: string[] = [];
  for (const l of asArray(labels)) {
    const nm = typeof l === 'string' ? l : l && typeof l.name === 'string' ? l.name : '';
    if (nm) out.push(nm);
  }
  return out;
}

function labelObject(l: any): { name: string; color: string; description: string } {
  const name = typeof l === 'string' ? l : l && typeof l.name === 'string' ? l.name : '';
  const color = typeof l === 'string' ? 'ededed' : l && typeof l.color === 'string' ? l.color : 'ededed';
  return { name, color, description: '' };
}

function issueLabelObjects(repo: any, labels: any): Array<{ name: string; color: string }> {
  return normalizeLabelNames(labels).map((nm: string) => ({ name: nm, color: labelColor(repo, nm) }));
}

function issueObject(repo: any, issue: any): any {
  const fullName = repo.full_name;
  const num = issue.number;
  return {
    id: num + 1000,
    number: num,
    title: issue.title,
    body: issue.body === undefined || issue.body === null ? '' : issue.body,
    state: issue.state,
    labels: issueLabelObjects(repo, issue.labels),
    user: userObject(issue.user),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    comments_url: '/api/v3/repos/' + fullName + '/issues/' + num + '/comments',
    html_url: 'https://github.com/' + fullName + '/issues/' + num,
  };
}

function commentObject(c: any): any {
  return {
    id: c.id,
    body: c.body,
    user: userObject(c.user),
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

function pullRef(v: any): string {
  if (typeof v === 'string') return v;
  if (v && typeof v.ref === 'string') return v.ref;
  return '';
}

function pullSha(repo: any, v: any): string {
  if (v && typeof v.sha === 'string') return v.sha;
  const ref = pullRef(v);
  if (ref && repo.branches && typeof repo.branches.get === 'function') {
    const sha = repo.branches.get(ref);
    if (typeof sha === 'string') return sha;
  }
  return ZERO_OID;
}

function pullObject(repo: any, pull: any): any {
  const fullName = repo.full_name;
  const num = pull.number;
  return {
    number: num,
    title: pull.title,
    body: pull.body === undefined || pull.body === null ? '' : pull.body,
    state: pull.state,
    head: { ref: pullRef(pull.head), sha: pullSha(repo, pull.head) },
    base: { ref: pullRef(pull.base), sha: pullSha(repo, pull.base) },
    merged: !!pull.merged,
    merged_at:
      pull.merged_at === undefined || pull.merged_at === null ? null : pull.merged_at,
    mergeable: true,
    merge_commit_sha:
      pull.merge_commit_sha === undefined || pull.merge_commit_sha === null ? null : pull.merge_commit_sha,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    user: userObject(pull.user),
    html_url: 'https://github.com/' + fullName + '/pull/' + num,
  };
}

function nextIssueNumber(repo: any): number {
  let max = 0;
  for (const i of asArray(repo.issues)) if (i && typeof i.number === 'number' && i.number > max) max = i.number;
  return max + 1;
}

function nextPullNumber(repo: any): number {
  let max = 0;
  for (const p of asArray(repo.pulls)) if (p && typeof p.number === 'number' && p.number > max) max = p.number;
  return max + 1;
}

function findIssueInArray(repo: any, n: number): any {
  return asArray(repo.issues).find((i: any) => i && i.number === n);
}

function findPullInArray(repo: any, n: number): any {
  return asArray(repo.pulls).find((p: any) => p && p.number === n);
}

function callGetIssue(store: any, repo: any, n: number): any {
  if (store.getIssue) {
    const r = store.getIssue(repo, n);
    if (r) return r;
  }
  return findIssueInArray(repo, n);
}

function callListIssues(store: any, repo: any, opts: any): any[] {
  if (store.listIssues) {
    const r = store.listIssues(repo, opts);
    if (Array.isArray(r)) return r;
  }
  const state = opts && opts.state ? opts.state : 'open';
  return asArray(repo.issues).filter((i: any) => (state === 'all' ? true : i && i.state === state));
}

function callCreateIssue(store: any, repo: any, fields: any): any {
  if (store.createIssue) {
    const r = store.createIssue(repo, fields);
    if (r) return r;
  }
  const created = nowIso();
  const rec: any = {
    number: nextIssueNumber(repo),
    title: fields.title,
    body: fields.body === undefined || fields.body === null ? '' : fields.body,
    state: 'open',
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    user: fields.user,
    created_at: created,
    updated_at: created,
    comments: [],
  };
  if (Array.isArray(repo.issues)) repo.issues.push(rec);
  return rec;
}

function callUpdateIssue(store: any, repo: any, n: number, fields: any): void {
  if (store.updateIssue) {
    store.updateIssue(repo, n, fields);
    return;
  }
  const issue = findIssueInArray(repo, n);
  if (!issue) return;
  if (fields.state !== undefined) issue.state = fields.state;
  if (fields.title !== undefined) issue.title = fields.title;
  if (fields.body !== undefined) issue.body = fields.body;
  if (fields.labels !== undefined) issue.labels = fields.labels;
  issue.updated_at = nowIso();
}

function callCreateComment(store: any, repo: any, n: number, body: string, user: string): any {
  if (store.createComment) {
    const r = store.createComment(repo, n, body, user);
    if (r) return r;
    const list = callListComments(store, repo, n);
    if (list.length > 0) return list[list.length - 1];
  }
  const created = nowIso();
  const rec: any = { id: ++__commentSeq, body, user, created_at: created, updated_at: created };
  const issue = findIssueInArray(repo, n);
  if (issue && Array.isArray(issue.comments)) issue.comments.push(rec);
  if (Array.isArray(repo.comments)) repo.comments.push(rec);
  return rec;
}

function callListComments(store: any, repo: any, n: number): any[] {
  if (store.listComments) {
    const r = store.listComments(repo, n);
    if (Array.isArray(r)) return r;
  }
  const issue = findIssueInArray(repo, n);
  if (issue && Array.isArray(issue.comments)) return issue.comments;
  return [];
}

function callCreateLabel(store: any, repo: any, name: string, color: string): any {
  if (store.createLabel) {
    const r = store.createLabel(repo, name, color);
    if (r) return r;
  }
  const rec: any = { name, color };
  if (Array.isArray(repo.labels)) {
    const existing = repo.labels.find((l: any) => l && l.name === name);
    if (existing) return existing;
    repo.labels.push(rec);
  }
  return rec;
}

function callListLabels(store: any, repo: any): any[] {
  if (store.listLabels) {
    const r = store.listLabels(repo);
    if (Array.isArray(r)) return r;
  }
  return asArray(repo.labels);
}

function callCreatePull(store: any, repo: any, fields: any): any {
  if (store.createPull) {
    const r = store.createPull(repo, fields);
    if (r) return r;
  }
  const created = nowIso();
  const rec: any = {
    number: nextPullNumber(repo),
    title: fields.title,
    body: fields.body === undefined || fields.body === null ? '' : fields.body,
    state: 'open',
    head: {
      ref: fields.head,
      sha: repo.branches && repo.branches.get ? repo.branches.get(fields.head) : undefined,
    },
    base: {
      ref: fields.base,
      sha: repo.branches && repo.branches.get ? repo.branches.get(fields.base) : undefined,
    },
    merged: false,
    user: fields.user,
    created_at: created,
    updated_at: created,
  };
  if (Array.isArray(repo.pulls)) repo.pulls.push(rec);
  return rec;
}

function callGetPull(store: any, repo: any, n: number): any {
  if (store.getPull) {
    const r = store.getPull(repo, n);
    if (r) return r;
  }
  return findPullInArray(repo, n);
}

function callListPulls(store: any, repo: any, opts: any): any[] {
  if (store.listPulls) {
    const r = store.listPulls(repo, opts);
    if (Array.isArray(r)) return r;
  }
  const state = opts && opts.state ? opts.state : 'open';
  return asArray(repo.pulls).filter((p: any) => (state === 'all' ? true : p && p.state === state));
}

function callUpdatePull(store: any, repo: any, n: number, fields: any): void {
  if (store.updatePull) {
    store.updatePull(repo, n, fields);
    return;
  }
  const pull = findPullInArray(repo, n);
  if (!pull) return;
  if (fields.state !== undefined) pull.state = fields.state;
  if (fields.merged !== undefined) pull.merged = fields.merged;
  if (fields.merged_at !== undefined) pull.merged_at = fields.merged_at;
  if (fields.merge_commit_sha !== undefined) pull.merge_commit_sha = fields.merge_commit_sha;
  pull.updated_at = nowIso();
}

function countLines(content: string): number {
  if (content === '') return 0;
  const parts = content.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

function lineTokens(content: string): string[] {
  if (content === '') return [];
  const parts = content.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function countLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = lineTokens(oldText);
  const b = lineTokens(newText);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = [];
  for (let i = 0; i <= n; i++) dp.push(new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcs = dp[0][0];
  return { additions: m - lcs, deletions: n - lcs };
}

export default createRestHandler;
