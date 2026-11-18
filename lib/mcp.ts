// lib/mcp.ts
// GitHub core clone — MCP surface (JSON-RPC 2.0 over HTTP at POST /mcp).
// Shares the in-memory store and per-branch git state with the REST and GraphQL
// surfaces, so every surface observes the same repositories, branches, files,
// issues and pull requests. Objects returned by the tools are byte-identical to
// what the REST surface shows for the same repo, issue or pull.

import { buildBlob, buildTree, buildCommit, createObjectStore } from './objects.ts';

type Headers = Record<string, string>;

interface McpRequest {
  method: string;
  headers: Headers;
  body: string;
}

interface McpResponse {
  status: number;
  headers: Headers;
  body: string;
}

const ZERO_OID = '0000000000000000000000000000000000000000';

function requestId(): string {
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function makeResponse(status: number, payload: unknown): McpResponse {
  return {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Request-Id': requestId(),
    },
    body: JSON.stringify(payload),
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

function extractId(bodyText: string): any {
  if (!bodyText) return null;
  try {
    const o = JSON.parse(bodyText);
    if (o && typeof o === 'object' && 'id' in o) return o.id;
  } catch {
    // ignore
  }
  return null;
}

class McpError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function asArray(v: any): any[] {
  return Array.isArray(v) ? v : [];
}

function ownerLogin(repo: any): string {
  if (typeof repo.owner === 'string') return repo.owner;
  if (repo.owner && typeof repo.owner.login === 'string') return repo.owner.login;
  return '';
}

function userObject(u: any): { login: string; id: number } {
  let login = '';
  if (typeof u === 'string') login = u;
  else if (u && typeof u.login === 'string') login = u.login;
  else if (u && typeof u.name === 'string') login = u.name;
  return { login, id: 1000 };
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

function labelColor(repo: any, name: string): string {
  for (const l of asArray(repo.labels)) {
    if (l && typeof l.name === 'string' && l.name === name && typeof l.color === 'string') return l.color;
  }
  return 'ededed';
}

function normalizeLabelNames(labels: any): string[] {
  const out: string[] = [];
  for (const l of asArray(labels)) {
    const nm = typeof l === 'string' ? l : l && typeof l.name === 'string' ? l.name : '';
    if (nm) out.push(nm);
  }
  return out;
}

function issueLabelObjects(repo: any, labels: any): Array<{ name: string; color: string }> {
  return normalizeLabelNames(labels).map((nm: string) => ({ name: nm, color: labelColor(repo, nm) }));
}

// REST-identical response builders (mirror lib/rest.ts repoToObject/issueObject/pullObject).
function repoObject(repo: any): any {
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
    mergeable: true,
    merge_commit_sha:
      pull.merge_commit_sha === undefined || pull.merge_commit_sha === null ? null : pull.merge_commit_sha,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    user: userObject(pull.user),
    html_url: 'https://github.com/' + fullName + '/pull/' + num,
  };
}

// Store wrappers (mirror lib/rest.ts call* helpers).
function callGetIssue(store: any, repo: any, n: number): any {
  if (store.getIssue) {
    const r = store.getIssue(repo, n);
    if (r) return r;
  }
  return asArray(repo.issues).find((i: any) => i && i.number === n);
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
  const created = new Date().toISOString();
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

function callGetPull(store: any, repo: any, n: number): any {
  if (store.getPull) {
    const r = store.getPull(repo, n);
    if (r) return r;
  }
  return asArray(repo.pulls).find((p: any) => p && p.number === n);
}

function callListPulls(store: any, repo: any, opts: any): any[] {
  if (store.listPulls) {
    const r = store.listPulls(repo, opts);
    if (Array.isArray(r)) return r;
  }
  const state = opts && opts.state ? opts.state : 'open';
  return asArray(repo.pulls).filter((p: any) => (state === 'all' ? true : p && p.state === state));
}

function callCreatePull(store: any, repo: any, fields: any): any {
  if (store.createPull) {
    const r = store.createPull(repo, fields);
    if (r) return r;
  }
  const created = new Date().toISOString();
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

function callUpdatePull(store: any, repo: any, n: number, fields: any): void {
  if (store.updatePull) {
    store.updatePull(repo, n, fields);
    return;
  }
  const pull = asArray(repo.pulls).find((p: any) => p && p.number === n);
  if (!pull) return;
  if (fields.state !== undefined) pull.state = fields.state;
  if (fields.merged !== undefined) pull.merged = fields.merged;
  if (fields.merged_at !== undefined) pull.merged_at = fields.merged_at;
  if (fields.merge_commit_sha !== undefined) pull.merge_commit_sha = fields.merge_commit_sha;
  pull.updated_at = new Date().toISOString();
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

// Per-branch git state helpers (mirror lib/rest.ts recordCommit/ensureBranch).
function branchKey(fullName: string, branch: string): string {
  return fullName + ':' + branch;
}

function ensureBranch(
  branchFiles: Map<string, Map<string, { content: string; oid: string }>>,
  branchCommits: Map<string, string[]>,
  repo: any,
  branch: string,
): Map<string, { content: string; oid: string }> {
  const key = branchKey(repo.full_name, branch);
  let map = branchFiles.get(key);
  if (!map) {
    map = new Map<string, { content: string; oid: string }>();
    branchFiles.set(key, map);
  }
  if (!branchCommits.has(key)) branchCommits.set(key, []);
  return map;
}

function syncDefaultBranchFiles(
  repo: any,
  branchFiles: Map<string, Map<string, { content: string; oid: string }>>,
): void {
  const db = repo.default_branch;
  const map = branchFiles.get(branchKey(repo.full_name, db));
  if (map && repo.files && typeof repo.files.clear === 'function') {
    repo.files.clear();
    map.forEach((v, k) => repo.files.set(k, { content: v.content, oid: v.oid }));
  }
}

function recordCommit(
  repo: any,
  branch: string,
  message: string,
  authorLogin: string,
  branchFiles: Map<string, Map<string, { content: string; oid: string }>>,
  branchCommits: Map<string, string[]>,
  objects: any,
): string {
  const map = ensureBranch(branchFiles, branchCommits, repo, branch);
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
  syncDefaultBranchFiles(repo, branchFiles);
  return commit.oid;
}

const SEED_LABELS: Array<[string, string]> = [
  ['bug', 'd73a4a'],
  ['enhancement', 'a2eeef'],
  ['documentation', '0075ca'],
  ['question', 'd876e3'],
  ['good first issue', '7057ff'],
  ['help wanted', '008672'],
];

// ---------------------------------------------------------------------------
// MCP tool definitions. The array is a module constant so tools/list answers
// with the exact same bytes on every call.
// ---------------------------------------------------------------------------
const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '0.0.0';
const PROTOCOL_VERSION = '2025-03-26';
const SUPPORTED_VERSIONS = ['2026-07-28', '2024-10-07', '2024-11-05', '2025-03-26', '2025-06-18'];
const CAPABILITIES = { tools: { listChanged: false } };

const TOOLS: Array<{
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, any>; required: string[] };
}> = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Optional repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        name: { type: 'string', description: 'Repository name (legacy fallback).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Optional issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface Ctx {
  store: any;
  viewer: string;
  branchFiles: Map<string, Map<string, { content: string; oid: string }>>;
  branchCommits: Map<string, string[]>;
  objects: any;
}

function seedLabels(ctx: Ctx, repo: any): void {
  for (const [name, color] of SEED_LABELS) {
    if (ctx.store.createLabel) ctx.store.createLabel(repo, name, color);
  }
}

function callTool(name: string, args: Record<string, any>, ctx: Ctx): any {
  switch (name) {
    case 'create_repo': {
      const nameArg = args.name;
      const existing = ctx.store.getRepo ? ctx.store.getRepo(ctx.viewer, nameArg) : undefined;
      if (existing) throw new McpError(-32602, 'Repository ' + nameArg + ' already exists');
      const repo = ctx.store.createRepo(ctx.viewer, nameArg, {
        description: typeof args.description === 'string' ? args.description : '',
        private: !!args.private,
        default_branch: typeof args.default_branch === 'string' ? args.default_branch : undefined,
      });
      seedLabels(ctx, repo);
      const key = branchKey(repo.full_name, repo.default_branch);
      if (!ctx.branchFiles.has(key)) ctx.branchFiles.set(key, new Map());
      if (!ctx.branchCommits.has(key)) ctx.branchCommits.set(key, []);
      return repoObject(repo);
    }
    case 'get_repo': {
      const repoName = args.repo !== undefined && args.repo !== null && args.repo !== '' ? args.repo : args.name;
      const repo = ctx.store.getRepo ? ctx.store.getRepo(args.owner, repoName) : undefined;
      if (!repo) throw new McpError(-32000, 'Repository not found: ' + args.owner + '/' + repoName);
      return repoObject(repo);
    }
    case 'create_issue': {
      const repo = ctx.store.getRepo ? ctx.store.getRepo(args.owner, args.repo) : undefined;
      if (!repo) throw new McpError(-32000, 'Repository not found: ' + args.owner + '/' + args.repo);
      const issue = callCreateIssue(ctx.store, repo, {
        title: args.title,
        body: args.body === undefined || args.body === null ? '' : args.body,
        labels: [],
        user: ctx.viewer,
      });
      return issueObject(repo, issue);
    }
    case 'list_issues': {
      const repo = ctx.store.getRepo ? ctx.store.getRepo(args.owner, args.repo) : undefined;
      if (!repo) throw new McpError(-32000, 'Repository not found: ' + args.owner + '/' + args.repo);
      const state = typeof args.state === 'string' && args.state !== '' ? args.state : 'open';
      const issues = callListIssues(ctx.store, repo, { state }).slice().sort((a: any, b: any) => {
        const cmp = String(a.created_at || '').localeCompare(String(b.created_at || ''));
        return -cmp;
      });
      return issues.map((i: any) => issueObject(repo, i));
    }
    case 'create_pull_request': {
      const repo = ctx.store.getRepo ? ctx.store.getRepo(args.owner, args.repo) : undefined;
      if (!repo) throw new McpError(-32000, 'Repository not found: ' + args.owner + '/' + args.repo);
      const headRef = args.head;
      const baseRef = args.base;
      const headSha = repo.branches && repo.branches.get ? repo.branches.get(headRef) : undefined;
      const baseSha = repo.branches && repo.branches.get ? repo.branches.get(baseRef) : undefined;
      if (!headSha) throw new McpError(-32000, 'head branch ' + headRef + ' does not exist');
      if (!baseSha && baseRef !== repo.default_branch) throw new McpError(-32000, 'base branch ' + baseRef + ' does not exist');
      const pull = callCreatePull(ctx.store, repo, {
        title: args.title,
        body: args.body === undefined || args.body === null ? '' : args.body,
        head: headRef,
        base: baseRef,
        user: ctx.viewer,
      });
      return pullObject(repo, pull);
    }
    case 'merge_pull_request': {
      const repo = ctx.store.getRepo ? ctx.store.getRepo(args.owner, args.repo) : undefined;
      if (!repo) throw new McpError(-32000, 'Repository not found: ' + args.owner + '/' + args.repo);
      const n = typeof args.pull_number === 'number' ? args.pull_number : parseInt(args.pull_number, 10);
      const pull = callGetPull(ctx.store, repo, n);
      if (!pull) throw new McpError(-32000, 'Pull request not found: #' + n);
      const headRef = pullRef(pull.head);
      const baseRef = pullRef(pull.base);
      const headMap = ctx.branchFiles.get(branchKey(repo.full_name, headRef)) || new Map();
      const baseMap = ensureBranch(ctx.branchFiles, ctx.branchCommits, repo, baseRef);
      let conflict: string | null = null;
      for (const [path, f] of headMap) {
        const bf = baseMap.get(path);
        if (bf && bf.content !== f.content) {
          conflict = path;
          break;
        }
      }
      if (conflict) throw new McpError(-32000, 'Merge conflict in ' + conflict);
      baseMap.clear();
      for (const [path, f] of headMap) {
        baseMap.set(path, { content: f.content, oid: f.oid });
      }
      const mergeOid = recordCommit(
        repo,
        baseRef,
        'Merge pull request #' + n + ' from ' + headRef,
        ctx.viewer,
        ctx.branchFiles,
        ctx.branchCommits,
        ctx.objects,
      );
      callUpdatePull(ctx.store, repo, n, {
        state: 'closed',
        merged: true,
        merged_at: new Date().toISOString(),
        merge_commit_sha: mergeOid,
      });
      const updated = callGetPull(ctx.store, repo, n) || pull;
      return { merged: true, state: updated.state };
    }
    default:
      throw new McpError(-32601, 'Method not found: ' + name);
  }
}

function handleToolCall(
  parsed: any,
  store: any,
  viewer: string,
  branchFiles: Map<string, Map<string, { content: string; oid: string }>>,
  branchCommits: Map<string, string[]>,
  objects: any,
): any {
  const params = parsed && parsed.params && typeof parsed.params === 'object' && !Array.isArray(parsed.params)
    ? parsed.params
    : {};
  const toolName = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new McpError(-32601, 'Method not found: ' + toolName);
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments
    : {};
  for (const r of tool.inputSchema.required) {
    const v = args[r];
    if (v === undefined || v === null || v === '') throw new McpError(-32602, 'Missing required argument: ' + r);
  }
  const value = callTool(toolName, args, { store, viewer, branchFiles, branchCommits, objects });
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function createMcpHandler(store: any, viewerLogin?: string, shared?: any) {
  const resolvedViewer = viewerLogin || process.env.MAKEFUN_VIEWER_LOGIN || 'adaiversen';

  // Shared state is read lazily from `shared` (the REST handler), mirroring the
  // GraphQL surface, so this surface observes the same store and per-branch git
  // state. Local maps are only used until the shared handler has run once.
  const localBranchFiles = new Map<string, Map<string, { content: string; oid: string }>>();
  const localBranchCommits = new Map<string, string[]>();
  const localObjects = createObjectStore();

  return async function handler(req: McpRequest): Promise<McpResponse> {
    const method = ((req && req.method) || 'GET').toUpperCase();
    const headers = (req && req.headers) || {};
    const bodyText = (req && req.body) || '';

    if (method !== 'POST') {
      return makeResponse(405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method Not Allowed' } });
    }

    const storeRef: any = shared && shared.store ? shared.store : store;
    const branchFiles: Map<string, Map<string, { content: string; oid: string }>> =
      shared && shared.branchFiles ? shared.branchFiles : localBranchFiles;
    const branchCommits: Map<string, string[]> =
      shared && shared.branchCommits ? shared.branchCommits : localBranchCommits;
    const objects: any = shared && shared.objects ? shared.objects : localObjects;

    if (!checkAuth(headers)) {
      return makeResponse(401, {
        jsonrpc: '2.0',
        id: extractId(bodyText),
        error: { code: -32001, message: 'Bad credentials' },
      });
    }

    let parsed: any;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return makeResponse(400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
    }

    const id = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'id' in parsed ? parsed.id : null;
    const rpcMethod = parsed && typeof parsed === 'object' && typeof parsed.method === 'string' ? parsed.method : '';

    let result: any;
    let error: { code: number; message: string } | null = null;

    if (rpcMethod === '') {
      error = { code: -32600, message: 'Invalid Request' };
    } else if (rpcMethod === 'server/discover') {
      result = {
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: CAPABILITIES,
        supportedVersions: SUPPORTED_VERSIONS,
      };
    } else if (rpcMethod === 'initialize') {
      const declared =
        parsed && parsed.params && typeof parsed.params.protocolVersion === 'string'
          ? parsed.params.protocolVersion
          : PROTOCOL_VERSION;
      result = {
        protocolVersion: declared,
        capabilities: CAPABILITIES,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      };
    } else if (rpcMethod === 'notifications/initialized') {
      result = {};
    } else if (rpcMethod === 'tools/list') {
      result = { tools: TOOLS };
    } else if (rpcMethod === 'tools/call') {
      try {
        result = handleToolCall(parsed, storeRef, resolvedViewer, branchFiles, branchCommits, objects);
      } catch (e: any) {
        error = {
          code: typeof e === 'object' && e && typeof e.code === 'number' ? e.code : -32000,
          message: String((e && e.message) || e),
        };
      }
    } else {
      error = { code: -32601, message: 'Method not found: ' + rpcMethod };
    }

    if (error) return makeResponse(200, { jsonrpc: '2.0', id, error });
    return makeResponse(200, { jsonrpc: '2.0', id, result });
  };
}

export default createMcpHandler;
