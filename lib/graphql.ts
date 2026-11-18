// lib/graphql.ts
// GitHub core clone — GraphQL v4 surface (queries only; mutations land in a later session).
// Shares the in-memory store and per-branch git state with the REST surface, so both
// surfaces observe the same repositories, branches, files, issues and pull requests.

import { createObjectStore } from './objects.ts';
import { buildBlob, buildTree, buildCommit } from './objects.ts';

type Headers = Record<string, string>;

interface GraphqlRequest {
  method: string;
  headers: Headers;
  body: string;
  segments?: string[];
}

interface GraphqlResponse {
  status: number;
  headers: Headers;
  body: string;
}

const PREFIX = ['api', 'graphql'];

function requestId(): string {
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function makeResponse(status: number, payload: unknown): GraphqlResponse {
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

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function unB64(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

function ownerLogin(repo: any): string {
  if (typeof repo.owner === 'string') return repo.owner;
  if (repo.owner && typeof repo.owner.login === 'string') return repo.owner.login;
  return '';
}

function userLogin(u: any): string {
  if (typeof u === 'string') return u;
  if (u && typeof u.login === 'string') return u.login;
  if (u && typeof u.name === 'string') return u.name;
  return '';
}

function pullRef(v: any): string {
  if (typeof v === 'string') return v;
  if (v && typeof v.ref === 'string') return v.ref;
  return '';
}

function asArray(v: any): any[] {
  return Array.isArray(v) ? v : [];
}

function branchKey(fullName: string, branch: string): string {
  return fullName + ':' + branch;
}

function countLines(content: string): number {
  if (content === '') return 0;
  const parts = content.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

function countLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length > 1 && a[a.length - 1] === '') a.pop();
  if (b.length > 1 && b[b.length - 1] === '') b.pop();
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

function encodeCursor(i: number): string {
  return b64('c' + i);
}

function decodeCursor(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined || cursor === '') return -1;
  try {
    const s = unB64(cursor);
    if (s.startsWith('c')) {
      const n = parseInt(s.slice(1), 10);
      if (!Number.isNaN(n) && n >= 0) return n;
    }
    const n = parseInt(s, 10);
    if (!Number.isNaN(n) && n >= 0) return n;
  } catch {
    // ignore
  }
  return -1;
}

function repoNodeId(fullName: string): string {
  return 'R_' + b64(fullName);
}

function issueNodeId(fullName: string, number: number): string {
  return 'I_' + b64(fullName + '#' + number);
}

function pullNodeId(fullName: string, number: number): string {
  return 'P_' + b64(fullName + '#' + number);
}

function byCreatedAsc(a: any, b: any): number {
  const c = String(a.created_at || '').localeCompare(String(b.created_at || ''));
  if (c !== 0) return c;
  return (a.number || 0) - (b.number || 0);
}

function byCreatedDesc(a: any, b: any): number {
  const c = String(b.created_at || '').localeCompare(String(a.created_at || ''));
  if (c !== 0) return c;
  return (b.number || 0) - (a.number || 0);
}

// Whether the caller asked the issues list to come back newest first. The kit
// expresses this as an order; accept both the GitHub-style `orderBy: {direction}`
// and a bare `order` whose value means newest-first. Anything else stays oldest first.
function newestFirst(args: Record<string, any>): boolean {
  const ob = args.orderBy;
  if (ob && typeof ob === 'object' && ob.direction !== undefined) {
    return String(ob.direction).toUpperCase() === 'DESC';
  }
  if (args.order !== undefined) {
    const o = String(args.order).toUpperCase();
    return o === 'DESC' || o === 'NEWEST_FIRST' || o === 'DESCENDING';
  }
  return false;
}

// Type schema used for introspection (name, kind and field names).
const TYPE_DEFS: Record<string, { kind: string; fields: string[]; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type'] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name'] },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'nodeId', 'name', 'nameWithOwner', 'fullName', 'description', 'private',
      'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'owner', 'createdAt',
      'updatedAt', 'issues', 'pullRequests', 'issue', 'pullRequest', 'url',
    ],
  },
  Ref: { kind: 'OBJECT', fields: ['name'] },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'nodeId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'repository'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'nodeId', 'number', 'title', 'body', 'state', 'author', 'headRefName', 'baseRefName', 'files', 'mergeable', 'createdAt', 'updatedAt', 'merged', 'url', 'repository'],
  },
  FileChange: { kind: 'OBJECT', fields: ['path', 'changeKind', 'additions', 'deletions'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['cursor', 'node'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['cursor', 'node'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'fields', 'enumValues'] },
  __Field: { kind: 'OBJECT', fields: ['name'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name'] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'PULL_REQUEST'] },
};

interface Ctx {
  store: any;
  viewer: string;
  branchFiles: Map<string, Map<string, { content: string; oid: string }>>;
  branchCommits: Map<string, string[]>;
  objects: any;
  fragments: Record<string, any>;
  errors: Array<{ message: string }>;
  variables: Record<string, any>;
}

function getIssue(repo: any, n: number, ctx: Ctx): any {
  if (ctx.store.getIssue) {
    const r = ctx.store.getIssue(repo, n);
    if (r) return r;
  }
  return asArray(repo.issues).find((i: any) => i && i.number === n);
}

function getPull(repo: any, n: number, ctx: Ctx): any {
  if (ctx.store.getPull) {
    const r = ctx.store.getPull(repo, n);
    if (r) return r;
  }
  return asArray(repo.pulls).find((p: any) => p && p.number === n);
}

function listIssues(repo: any, ctx: Ctx): any[] {
  if (ctx.store.listIssues) {
    const r = ctx.store.listIssues(repo, { state: 'all' });
    if (Array.isArray(r)) return r;
  }
  return asArray(repo.issues);
}

function listPulls(repo: any, ctx: Ctx): any[] {
  if (ctx.store.listPulls) {
    const r = ctx.store.listPulls(repo, { state: 'all' });
    if (Array.isArray(r)) return r;
  }
  return asArray(repo.pulls);
}

function makeConnection(
  connType: string,
  edgeType: string,
  items: any[],
  args: Record<string, any>,
  wrap: (item: any, index: number) => any,
): any {
  const first = typeof args.first === 'number' ? args.first : undefined;
  const after = args.after !== undefined && args.after !== null ? args.after : undefined;
  let start = 0;
  if (after !== undefined) {
    const decoded = decodeCursor(after);
    start = decoded + 1;
  }
  if (start < 0) start = 0;
  let end = items.length;
  if (typeof first === 'number' && first >= 0) end = Math.min(start + first, items.length);
  const slice = items.slice(start, end);
  const nodes = slice.map((item, i) => wrap(item, start + i));
  const edges = slice.map((item, i) => ({
    __typename: edgeType,
    cursor: encodeCursor(start + i),
    node: wrap(item, start + i),
  }));
  const hasNextPage = end < items.length;
  const hasPreviousPage = start > 0;
  const endCursor = slice.length > 0 ? encodeCursor(start + slice.length - 1) : start > 0 ? encodeCursor(start - 1) : null;
  const startCursor = slice.length > 0 ? encodeCursor(start) : null;
  return {
    __typename: connType,
    nodes,
    edges,
    pageInfo: { __typename: 'PageInfo', hasNextPage, hasPreviousPage, startCursor, endCursor },
    totalCount: items.length,
  };
}

function issuesConnection(repo: any, args: Record<string, any>, ctx: Ctx): any {
  let items = listIssues(repo, ctx).slice();
  // Honour the caller's states filter: the stored state is lowercase, the
  // requested values are uppercase, so compare them in the same (lower) case.
  if (Array.isArray(args.states) && args.states.length > 0) {
    const want = new Set(args.states.map((s: any) => String(s).toLowerCase()));
    items = items.filter((i: any) => i && i.state !== undefined && want.has(String(i.state).toLowerCase()));
  }
  items.sort(newestFirst(args) ? byCreatedDesc : byCreatedAsc);
  return makeConnection('IssueConnection', 'IssueEdge', items, args, (item) => ({
    __typename: 'Issue',
    repo,
    issue: item,
  }));
}

function pullsConnection(repo: any, args: Record<string, any>, ctx: Ctx): any {
  const items = listPulls(repo, ctx).slice().sort(byCreatedAsc);
  return makeConnection('PullRequestConnection', 'PullRequestEdge', items, args, (item) => ({
    __typename: 'PullRequest',
    repo,
    pull: item,
  }));
}

function pullFiles(repo: any, pull: any, ctx: Ctx): any[] {
  const headRef = pullRef(pull.head);
  const baseRef = pullRef(pull.base);
  const headMap = ctx.branchFiles.get(branchKey(repo.full_name, headRef)) || new Map();
  const baseMap = ctx.branchFiles.get(branchKey(repo.full_name, baseRef)) || new Map();
  const paths = new Set<string>();
  headMap.forEach((_v: any, k: string) => paths.add(k));
  baseMap.forEach((_v: any, k: string) => paths.add(k));
  const list: any[] = [];
  for (const path of Array.from(paths).sort()) {
    const h = headMap.get(path);
    const b = baseMap.get(path);
    if (h && !b) {
      list.push({ __typename: 'FileChange', path, changeKind: 'added', additions: countLines(h.content), deletions: 0 });
    } else if (h && b && h.content !== b.content) {
      const d = countLineDiff(b.content, h.content);
      list.push({ __typename: 'FileChange', path, changeKind: 'modified', additions: d.additions, deletions: d.deletions });
    } else if (!h && b) {
      list.push({ __typename: 'FileChange', path, changeKind: 'removed', additions: 0, deletions: countLines(b.content) });
    }
  }
  return list;
}

function resolveNode(id: string, ctx: Ctx): any {
  if (typeof id !== 'string' || id.length < 3) return null;
  const prefix = id.slice(0, 2);
  const payload = id.slice(2);
  try {
    if (prefix === 'R_') {
      const fullName = unB64(payload);
      const slash = fullName.indexOf('/');
      if (slash <= 0) return null;
      const owner = fullName.slice(0, slash);
      const name = fullName.slice(slash + 1);
      const repo = ctx.store.getRepo ? ctx.store.getRepo(owner, name) : undefined;
      return repo ? { __typename: 'Repository', repo } : null;
    }
    if (prefix === 'I_' || prefix === 'P_') {
      const s = unB64(payload);
      const hash = s.lastIndexOf('#');
      if (hash <= 0) return null;
      const fullName = s.slice(0, hash);
      const num = parseInt(s.slice(hash + 1), 10);
      if (Number.isNaN(num)) return null;
      const slash = fullName.indexOf('/');
      if (slash <= 0) return null;
      const owner = fullName.slice(0, slash);
      const name = fullName.slice(slash + 1);
      const repo = ctx.store.getRepo ? ctx.store.getRepo(owner, name) : undefined;
      if (!repo) return null;
      if (prefix === 'I_') {
        const issue = getIssue(repo, num, ctx);
        return issue ? { __typename: 'Issue', repo, issue } : null;
      }
      const pull = getPull(repo, num, ctx);
      return pull ? { __typename: 'PullRequest', repo, pull } : null;
    }
  } catch {
    return null;
  }
  return null;
}

function userObject(login: string): any {
  return { __typename: 'User', login, id: 1000, name: login };
}

type FieldResolver = (parent: any, args: Record<string, any>, ctx: Ctx) => any;

const resolvers: Record<string, Record<string, FieldResolver>> = {
  Query: {
    viewer: (_p, _a, ctx) => userObject(ctx.viewer),
    repository: (_p, args, ctx) => {
      const repo = ctx.store.getRepo ? ctx.store.getRepo(args.owner, args.name) : undefined;
      if (!repo) return null;
      return { __typename: 'Repository', repo };
    },
    node: (_p, args, ctx) => resolveNode(args.id, ctx),
    __type: (_p, args, _ctx) => {
      const def = TYPE_DEFS[args.name];
      if (!def) return null;
      return {
        __typename: '__Type',
        name: args.name,
        kind: def.kind,
        fields: def.fields.map((f) => ({ __typename: '__Field', name: f })),
        enumValues: def.enumValues ? def.enumValues.map((v) => ({ __typename: '__EnumValue', name: v })) : null,
      };
    },
  },
  User: {
    login: (p) => p.login,
    id: (p) => p.id,
    name: (p) => p.name,
  },
  Repository: {
    id: (p) => repoNodeId(p.repo.full_name),
    databaseId: (p) => p.repo.id,
    nodeId: (p) => repoNodeId(p.repo.full_name),
    name: (p) => p.repo.name,
    nameWithOwner: (p) => p.repo.full_name,
    fullName: (p) => p.repo.full_name,
    description: (p) => (p.repo.description === undefined || p.repo.description === null ? '' : p.repo.description),
    private: (p) => !!p.repo.private,
    defaultBranchRef: (p) => ({ __typename: 'Ref', name: p.repo.default_branch }),
    viewerPermission: (p, _a, ctx) => (ownerLogin(p.repo) === ctx.viewer ? 'ADMIN' : 'WRITE'),
    hasIssuesEnabled: () => true,
    owner: (p) => userObject(ownerLogin(p.repo)),
    createdAt: (p) => p.repo.created_at,
    updatedAt: (p) => p.repo.updated_at,
    issues: (p, args, ctx) => issuesConnection(p.repo, args, ctx),
    pullRequests: (p, args, ctx) => pullsConnection(p.repo, args, ctx),
    issue: (p, args, ctx) => {
      const n = typeof args.number === 'number' ? args.number : parseInt(args.number, 10);
      const issue = getIssue(p.repo, n, ctx);
      return issue ? { __typename: 'Issue', repo: p.repo, issue } : null;
    },
    pullRequest: (p, args, ctx) => {
      const n = typeof args.number === 'number' ? args.number : parseInt(args.number, 10);
      const pull = getPull(p.repo, n, ctx);
      return pull ? { __typename: 'PullRequest', repo: p.repo, pull } : null;
    },
    url: (p) => 'https://github.com/' + p.repo.full_name,
  },
  Ref: {
    name: (p) => p.name,
  },
  Issue: {
    id: (p) => issueNodeId(p.repo.full_name, p.issue.number),
    nodeId: (p) => issueNodeId(p.repo.full_name, p.issue.number),
    number: (p) => p.issue.number,
    title: (p) => p.issue.title,
    body: (p) => (p.issue.body === undefined || p.issue.body === null ? '' : p.issue.body),
    state: (p) => (String(p.issue.state).toLowerCase() === 'closed' ? 'CLOSED' : 'OPEN'),
    author: (p) => userObject(userLogin(p.issue.user)),
    createdAt: (p) => p.issue.created_at,
    updatedAt: (p) => p.issue.updated_at,
    url: (p) => 'https://github.com/' + p.repo.full_name + '/issues/' + p.issue.number,
    repository: (p) => ({ __typename: 'Repository', repo: p.repo }),
  },
  PullRequest: {
    id: (p) => pullNodeId(p.repo.full_name, p.pull.number),
    nodeId: (p) => pullNodeId(p.repo.full_name, p.pull.number),
    number: (p) => p.pull.number,
    title: (p) => p.pull.title,
    body: (p) => (p.pull.body === undefined || p.pull.body === null ? '' : p.pull.body),
    state: (p) => (String(p.pull.state).toLowerCase() === 'closed' ? 'CLOSED' : 'OPEN'),
    author: (p) => userObject(userLogin(p.pull.user)),
    headRefName: (p) => pullRef(p.pull.head),
    baseRefName: (p) => pullRef(p.pull.base),
    files: (p, args, ctx) => pullFilesConnection(p.repo, p.pull, args, ctx),
    createdAt: (p) => p.pull.created_at,
    updatedAt: (p) => p.pull.updated_at,
    merged: (p) => !!p.pull.merged,
    url: (p) => 'https://github.com/' + p.repo.full_name + '/pull/' + p.pull.number,
    repository: (p) => ({ __typename: 'Repository', repo: p.repo }),
  },
  FileChange: {
    path: (p) => p.path,
    changeKind: (p) => p.changeKind,
    additions: (p) => p.additions,
    deletions: (p) => p.deletions,
  },
  IssueConnection: {
    nodes: (p) => p.nodes,
    edges: (p) => p.edges,
    pageInfo: (p) => p.pageInfo,
    totalCount: (p) => p.totalCount,
  },
  PullRequestConnection: {
    nodes: (p) => p.nodes,
    edges: (p) => p.edges,
    pageInfo: (p) => p.pageInfo,
    totalCount: (p) => p.totalCount,
  },
  IssueEdge: {
    cursor: (p) => p.cursor,
    node: (p) => p.node,
  },
  PullRequestEdge: {
    cursor: (p) => p.cursor,
    node: (p) => p.node,
  },
  PageInfo: {
    hasNextPage: (p) => p.hasNextPage,
    hasPreviousPage: (p) => p.hasPreviousPage,
    startCursor: (p) => p.startCursor,
    endCursor: (p) => p.endCursor,
  },
  __Type: {
    name: (p) => p.name,
    kind: (p) => p.kind,
    fields: (p) => p.fields,
    enumValues: (p) => p.enumValues,
  },
  __Field: {
    name: (p) => p.name,
  },
  __EnumValue: {
    name: (p) => p.name,
  },
};

// ---------------------------------------------------------------------------
// Mutations and the pull-request files connection (added by this session).
// The shared store, per-branch file/commit maps and object store are reached
// through `shared`, so a change made here is observed by the REST surface too.
// The handler executes every root selection under the Query type, so the five
// mutations are registered on the Query root (they still behave as mutations).
// ---------------------------------------------------------------------------

let __commentSeq = 0;

function nowIso(): string {
  return new Date().toISOString();
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

function decodeRepoId(id: any, ctx: Ctx): any {
  if (typeof id !== 'string' || id.slice(0, 2) !== 'R_') return null;
  const fullName = unB64(id.slice(2));
  const slash = fullName.indexOf('/');
  if (slash <= 0) return null;
  const repo = ctx.store.getRepo ? ctx.store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1)) : undefined;
  return repo || null;
}

function decodeSubjectId(id: any, ctx: Ctx): { prefix: string; repo: any; number: number; fullName: string } | null {
  if (typeof id !== 'string' || id.length < 3) return null;
  const prefix = id.slice(0, 2);
  if (prefix !== 'I_' && prefix !== 'P_') return null;
  const s = unB64(id.slice(2));
  const hash = s.lastIndexOf('#');
  if (hash <= 0) return null;
  const fullName = s.slice(0, hash);
  const num = parseInt(s.slice(hash + 1), 10);
  if (Number.isNaN(num)) return null;
  const slash = fullName.indexOf('/');
  if (slash <= 0) return null;
  const repo = ctx.store.getRepo ? ctx.store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1)) : undefined;
  if (!repo) return null;
  return { prefix, repo, number: num, fullName };
}

function commentNodeId(fullName: string, number: number, commentId: any): string {
  return 'C_' + b64(fullName + '#' + number + ':c' + commentId);
}

function mutGetIssue(repo: any, n: number, ctx: Ctx): any {
  if (ctx.store.getIssue) {
    const r = ctx.store.getIssue(repo, n);
    if (r) return r;
  }
  return asArray(repo.issues).find((i: any) => i && i.number === n);
}

function mutGetPull(repo: any, n: number, ctx: Ctx): any {
  if (ctx.store.getPull) {
    const r = ctx.store.getPull(repo, n);
    if (r) return r;
  }
  return asArray(repo.pulls).find((p: any) => p && p.number === n);
}

function mutCreateIssue(repo: any, fields: any, ctx: Ctx): any {
  if (ctx.store.createIssue) {
    const r = ctx.store.createIssue(repo, fields);
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

function mutUpdateIssue(repo: any, n: number, fields: any, ctx: Ctx): void {
  if (ctx.store.updateIssue) {
    ctx.store.updateIssue(repo, n, fields);
    return;
  }
  const issue = asArray(repo.issues).find((i: any) => i && i.number === n);
  if (!issue) return;
  if (fields.state !== undefined) issue.state = fields.state;
  if (fields.title !== undefined) issue.title = fields.title;
  if (fields.body !== undefined) issue.body = fields.body;
  issue.updated_at = nowIso();
}

function mutCreatePull(repo: any, fields: any, ctx: Ctx): any {
  if (ctx.store.createPull) {
    const r = ctx.store.createPull(repo, fields);
    if (r) return r;
  }
  const created = nowIso();
  const rec: any = {
    number: nextPullNumber(repo),
    title: fields.title,
    body: fields.body === undefined || fields.body === null ? '' : fields.body,
    state: 'open',
    head: { ref: fields.head, sha: repo.branches && repo.branches.get ? repo.branches.get(fields.head) : undefined },
    base: { ref: fields.base, sha: repo.branches && repo.branches.get ? repo.branches.get(fields.base) : undefined },
    merged: false,
    user: fields.user,
    created_at: created,
    updated_at: created,
  };
  if (Array.isArray(repo.pulls)) repo.pulls.push(rec);
  return rec;
}

function mutUpdatePull(repo: any, n: number, fields: any, ctx: Ctx): void {
  if (ctx.store.updatePull) {
    ctx.store.updatePull(repo, n, fields);
    return;
  }
  const pull = asArray(repo.pulls).find((p: any) => p && p.number === n);
  if (!pull) return;
  if (fields.state !== undefined) pull.state = fields.state;
  if (fields.merged !== undefined) pull.merged = fields.merged;
  if (fields.merged_at !== undefined) pull.merged_at = fields.merged_at;
  if (fields.merge_commit_sha !== undefined) pull.merge_commit_sha = fields.merge_commit_sha;
  pull.updated_at = nowIso();
}

function mutCreateComment(
  repo: any,
  subject: { prefix: string; number: number },
  body: string,
  user: string,
  ctx: Ctx,
): any {
  const created = nowIso();
  if (subject.prefix === 'I_' && ctx.store.createComment) {
    const r = ctx.store.createComment(repo, subject.number, body, user);
    if (r) return r;
  }
  const rec: any = { id: ++__commentSeq, body, user, created_at: created, updated_at: created };
  if (subject.prefix === 'I_') {
    const issue = asArray(repo.issues).find((i: any) => i && i.number === subject.number);
    if (issue) {
      if (!Array.isArray(issue.comments)) issue.comments = [];
      issue.comments.push(rec);
    }
  } else {
    const pull = asArray(repo.pulls).find((p: any) => p && p.number === subject.number);
    if (pull) {
      if (!Array.isArray(pull.comments)) pull.comments = [];
      pull.comments.push(rec);
    }
  }
  if (Array.isArray(repo.comments)) repo.comments.push(rec);
  return rec;
}

// Record a commit on `branch` from its current file map, mirroring the REST
// merge: build a tree from the branch's files, a commit whose parent is the
// branch tip and whose author is the viewer, store it in the shared object
// store, advance the branch and mirror the files into the repo when the branch
// is the default branch.
function gqlRecordCommit(ctx: Ctx, repo: any, branch: string, message: string, authorLogin: string): string {
  const key = branchKey(repo.full_name, branch);
  let map = ctx.branchFiles.get(key);
  if (!map) {
    map = new Map<string, { content: string; oid: string }>();
    ctx.branchFiles.set(key, map);
  }
  if (!ctx.branchCommits.has(key)) ctx.branchCommits.set(key, []);
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  for (const [name, file] of map) {
    const blob = buildBlob(file.content);
    ctx.objects.put(blob.oid, { type: 'blob', raw: blob.raw });
    entries.push({ mode: '100644', name, oid: blob.oid });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const tree = buildTree(entries);
  ctx.objects.put(tree.oid, { type: 'tree', raw: tree.raw });
  const commits = ctx.branchCommits.get(key) as string[];
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
  ctx.objects.put(commit.oid, { type: 'commit', raw: commit.raw });
  commits.unshift(commit.oid);
  if (repo.branches && typeof repo.branches.set === 'function') repo.branches.set(branch, commit.oid);
  if (branch === repo.default_branch && repo.files && typeof repo.files.clear === 'function') {
    repo.files.clear();
    map.forEach((v, k) => repo.files.set(k, { content: v.content, oid: v.oid }));
  }
  return commit.oid;
}

// mergeable mirrors the REST conflict check: a pull cannot be merged when the
// head branch changed a file to different content than the base branch holds.
function pullMergeable(repo: any, pull: any, ctx: Ctx): boolean {
  const headRef = pullRef(pull.head);
  const baseRef = pullRef(pull.base);
  const headMap = ctx.branchFiles.get(branchKey(repo.full_name, headRef)) || new Map();
  const baseMap = ctx.branchFiles.get(branchKey(repo.full_name, baseRef)) || new Map();
  for (const [path, f] of headMap) {
    const bf = baseMap.get(path);
    if (bf && bf.content !== f.content) return false;
  }
  return true;
}

function pullFilesConnection(repo: any, pull: any, args: Record<string, any>, ctx: Ctx): any {
  const items = pullFiles(repo, pull, ctx);
  return makeConnection('PullRequestFileConnection', 'PullRequestFileEdge', items, args, (item: any) => item);
}

Object.assign(TYPE_DEFS, {
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  },
  PullRequestFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo'] },
  PullRequestFileEdge: { kind: 'OBJECT', fields: ['cursor', 'node'] },
  Comment: { kind: 'OBJECT', fields: ['id', 'body'] },
  CommentEdge: { kind: 'OBJECT', fields: ['cursor', 'node'] },
});

resolvers['PullRequest'].mergeable = (p: any, _a: any, ctx: Ctx) =>
  pullMergeable(p.repo, p.pull, ctx) ? 'MERGEABLE' : 'CONFLICTING';
resolvers['PullRequestFileConnection'] = {
  nodes: (p: any) => p.nodes,
  edges: (p: any) => p.edges,
  pageInfo: (p: any) => p.pageInfo,
};
resolvers['PullRequestFileEdge'] = {
  cursor: (p: any) => p.cursor,
  node: (p: any) => p.node,
};
resolvers['Comment'] = {
  id: (p: any) => p.id,
  body: (p: any) => p.body,
};
resolvers['CommentEdge'] = {
  cursor: (p: any) => p.cursor,
  node: (p: any) => p.node,
};

Object.assign(resolvers['Query'], {
  createIssue: (_p: any, args: any, ctx: Ctx) => {
    const input = (args && args.input) || {};
    const repo = decodeRepoId(input.repositoryId, ctx);
    if (!repo) throw new Error('Repository not found');
    const title = typeof input.title === 'string' ? input.title : '';
    if (title === '') throw new Error('Title is required');
    const issue = mutCreateIssue(repo, { title, body: input.body, user: ctx.viewer }, ctx);
    return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } };
  },
  closeIssue: (_p: any, args: any, ctx: Ctx) => {
    const input = (args && args.input) || {};
    const subj = decodeSubjectId(input.issueId, ctx);
    if (!subj || subj.prefix !== 'I_') throw new Error('Issue not found');
    const { repo, number } = subj;
    const issue = mutGetIssue(repo, number, ctx);
    if (!issue) throw new Error('Issue not found');
    mutUpdateIssue(repo, number, { state: 'closed' }, ctx);
    const updated = mutGetIssue(repo, number, ctx) || issue;
    return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo, issue: updated } };
  },
  createPullRequest: (_p: any, args: any, ctx: Ctx) => {
    const input = (args && args.input) || {};
    const repo = decodeRepoId(input.repositoryId, ctx);
    if (!repo) throw new Error('Repository not found');
    const title = typeof input.title === 'string' ? input.title : '';
    if (title === '') throw new Error('Title is required');
    const headRef = typeof input.headRefName === 'string' ? input.headRefName : (typeof input.headBranchName === 'string' ? input.headBranchName : '');
    const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : (typeof input.baseBranchName === 'string' ? input.baseBranchName : '');
    if (!headRef || !baseRef) throw new Error('head and base branch are required');
    const headSha = repo.branches && repo.branches.get ? repo.branches.get(headRef) : undefined;
    const baseSha = repo.branches && repo.branches.get ? repo.branches.get(baseRef) : undefined;
    if (!headSha) throw new Error('head branch ' + headRef + ' does not exist');
    if (!baseSha && baseRef !== repo.default_branch) throw new Error('base branch ' + baseRef + ' does not exist');
    const pull = mutCreatePull(repo, { title, body: input.body, head: headRef, base: baseRef, user: ctx.viewer }, ctx);
    return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } };
  },
  mergePullRequest: (_p: any, args: any, ctx: Ctx) => {
    const input = (args && args.input) || {};
    const subj = decodeSubjectId(input.pullRequestId, ctx) || decodeSubjectId(input.pullId, ctx);
    if (!subj || subj.prefix !== 'P_') throw new Error('Pull request not found');
    const { repo, number, fullName } = subj;
    const pull = mutGetPull(repo, number, ctx);
    if (!pull) throw new Error('Pull request not found');
    const headRef = pullRef(pull.head);
    const baseRef = pullRef(pull.base);
    const headMap = ctx.branchFiles.get(branchKey(fullName, headRef)) || new Map();
    let baseMap = ctx.branchFiles.get(branchKey(fullName, baseRef));
    if (!baseMap) {
      baseMap = new Map<string, { content: string; oid: string }>();
      ctx.branchFiles.set(branchKey(fullName, baseRef), baseMap);
    }
    let conflict: string | null = null;
    for (const [path, f] of headMap) {
      const bf = baseMap.get(path);
      if (bf && bf.content !== f.content) {
        conflict = path;
        break;
      }
    }
    if (conflict) throw new Error('Merge conflict in ' + conflict);
    baseMap.clear();
    for (const [path, f] of headMap) {
      baseMap.set(path, { content: f.content, oid: f.oid });
    }
    const mergeOid = gqlRecordCommit(ctx, repo, baseRef, 'Merge pull request #' + number + ' from ' + headRef, ctx.viewer);
    mutUpdatePull(repo, number, { state: 'closed', merged: true, merged_at: nowIso(), merge_commit_sha: mergeOid }, ctx);
    const updated = mutGetPull(repo, number, ctx) || pull;
    return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull: updated } };
  },
  addComment: (_p: any, args: any, ctx: Ctx) => {
    const input = (args && args.input) || {};
    const subj = decodeSubjectId(input.subjectId, ctx);
    if (!subj) throw new Error('Subject not found');
    const { repo, number, fullName } = subj;
    const body = typeof input.body === 'string' ? input.body : '';
    if (body === '') throw new Error('Body is required');
    const comment = mutCreateComment(repo, subj, body, ctx.viewer, ctx);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'CommentEdge',
        cursor: encodeCursor(0),
        node: { __typename: 'Comment', id: commentNodeId(fullName, number, comment.id), body: comment.body, comment },
      },
    };
  },
});

// Payload types wrapping the created/updated objects, so a mutation selection
// like `createIssue { issue { number id } }` resolves the `issue` field against
// the payload object returned by the resolver.
Object.assign(resolvers, {
  CreateIssuePayload: { issue: (p: any) => p.issue },
  CloseIssuePayload: { issue: (p: any) => p.issue },
  CreatePullRequestPayload: { pullRequest: (p: any) => p.pullRequest },
  MergePullRequestPayload: { pullRequest: (p: any) => p.pullRequest },
  AddCommentPayload: { commentEdge: (p: any) => p.commentEdge },
});

type Tok = { kind: string; value: string };

function tokenize(src: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ kind: 'SPREAD', value: '...' });
      i += 3;
      continue;
    }
    if (c === '{' || c === '}' || c === '(' || c === ')' || c === '[' || c === ']' || c === ':' || c === ',' || c === '!' || c === '$' || c === '=' || c === '@') {
      tokens.push({ kind: 'PUNCT', value: c });
      i++;
      continue;
    }
    if (c === '"') {
      let s = '';
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          const e = src[i + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else {
          s += src[i];
          i++;
        }
      }
      i++;
      tokens.push({ kind: 'STRING', value: s });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] || ''))) {
      let s = '';
      if (c === '-') {
        s += '-';
        i++;
      }
      while (i < n && /[0-9.]/.test(src[i])) {
        s += src[i];
        i++;
      }
      tokens.push({ kind: s.includes('.') ? 'FLOAT' : 'INT', value: s });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let s = '';
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) {
        s += src[i];
        i++;
      }
      tokens.push({ kind: 'NAME', value: s });
      continue;
    }
    throw new Error('Unexpected character "' + c + '"');
  }
  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

class GraphqlParser {
  private pos = 0;
  private tokens: Tok[];
  constructor(tokens: Tok[]) {
    this.tokens = tokens;
  }
  private peek(): Tok {
    return this.tokens[this.pos];
  }
  private next(): Tok {
    return this.tokens[this.pos++];
  }
  private expect(v: string): Tok {
    const t = this.next();
    if (t.value !== v) throw new Error('Expected "' + v + '" but got "' + t.value + '"');
    return t;
  }
  private skipCommas(): void {
    while (this.peek().value === ',') this.next();
  }
  private skipType(): void {
    if (this.peek().value === '[') {
      this.next();
      this.skipType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek().value === '!') this.next();
  }
  private skipDirectives(): void {
    while (this.peek().value === '@') {
      this.next();
      this.next();
      if (this.peek().value === '(') {
        this.next();
        while (this.peek().value !== ')') this.next();
        this.expect(')');
      }
    }
  }
  private parseValue(): any {
    const t = this.peek();
    if (t.kind === 'STRING') {
      this.next();
      return t.value;
    }
    if (t.kind === 'INT') {
      this.next();
      return parseInt(t.value, 10);
    }
    if (t.kind === 'FLOAT') {
      this.next();
      return parseFloat(t.value);
    }
    if (t.value === '$') {
      this.next();
      return { variable: this.next().value };
    }
    if (t.value === '[') {
      this.next();
      const arr: any[] = [];
      while (true) {
        this.skipCommas();
        if (this.peek().value === ']') break;
        arr.push(this.parseValue());
      }
      this.expect(']');
      return arr;
    }
    if (t.value === '{') {
      this.next();
      const obj: Record<string, any> = {};
      while (true) {
        this.skipCommas();
        if (this.peek().value === '}') break;
        const k = this.next().value;
        this.expect(':');
        obj[k] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    const v = this.next().value;
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null') return null;
    return v;
  }
  private parseSelection(): any {
    if (this.peek().value === '...') {
      this.next();
      if (this.peek().value === 'on') {
        this.next();
        const typeCond = this.next().value;
        this.skipDirectives();
        return { kind: 'fragment', typeCondition: typeCond, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().value === '@') {
        this.skipDirectives();
        return { kind: 'fragment', typeCondition: undefined, selectionSet: this.parseSelectionSet() };
      }
      const fname = this.next().value;
      this.skipDirectives();
      return { kind: 'spread', name: fname };
    }
    let name = this.next().value;
    let alias: string | undefined;
    if (this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args: Record<string, any> = {};
    if (this.peek().value === '(') {
      this.next();
      while (true) {
        this.skipCommas();
        if (this.peek().value === ')') break;
        const an = this.next().value;
        this.expect(':');
        args[an] = this.parseValue();
      }
      this.expect(')');
    }
    this.skipDirectives();
    let selectionSet: any[] | undefined;
    if (this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selectionSet };
  }
  private parseSelectionSet(): any[] {
    this.expect('{');
    const sel: any[] = [];
    while (true) {
      this.skipCommas();
      if (this.peek().value === '}') break;
      if (this.peek().kind === 'EOF') throw new Error('Unterminated selection set');
      sel.push(this.parseSelection());
    }
    this.expect('}');
    return sel;
  }
  parseDocument(): { selectionSet: any[]; fragments: Record<string, any> } {
    const fragments: Record<string, any> = {};
    let selectionSet: any[] | null = null;
    while (this.peek().kind !== 'EOF') {
      const t = this.peek();
      if (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription') {
        this.next();
        if (this.peek().kind === 'NAME') this.next();
        if (this.peek().value === '(') {
          this.next();
          while (true) {
            this.skipCommas();
            if (this.peek().value === ')') break;
            this.next();
            this.next();
            this.next();
            this.skipType();
            if (this.peek().value === '=') {
              this.next();
              this.parseValue();
            }
          }
          this.expect(')');
        }
        this.skipDirectives();
        if (this.peek().value === '{') selectionSet = this.parseSelectionSet();
      } else if (t.value === 'fragment') {
        this.next();
        const fname = this.next().value;
        this.expect('on');
        const typeCond = this.next().value;
        this.skipDirectives();
        fragments[fname] = { typeCondition: typeCond, selectionSet: this.parseSelectionSet() };
      } else if (t.value === '{') {
        selectionSet = this.parseSelectionSet();
      } else {
        this.next();
      }
    }
    if (!selectionSet) throw new Error('No query found');
    return { selectionSet, fragments };
  }
}

function parseGraphql(source: string): { selectionSet: any[]; fragments: Record<string, any> } {
  return new GraphqlParser(tokenize(source)).parseDocument();
}

function resolveValue(v: any, ctx: Ctx): any {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'variable' in v) {
    return ctx.variables[v.variable];
  }
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, ctx));
  if (v && typeof v === 'object') {
    const o: Record<string, any> = {};
    for (const [k, x] of Object.entries(v)) o[k] = resolveValue(x, ctx);
    return o;
  }
  return v;
}

function resolveArgs(args: Record<string, any>, ctx: Ctx): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(args)) out[k] = resolveValue(v, ctx);
  return out;
}

function execute(selectionSet: any[], typeName: string, value: any, ctx: Ctx): any {
  if (value === null || value === undefined) return null;
  const result: Record<string, any> = {};
  for (const sel of selectionSet) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments[sel.name];
      if (frag) Object.assign(result, execute(frag.selectionSet, typeName, value, ctx));
      continue;
    }
    if (sel.kind === 'fragment') {
      const cond = sel.typeCondition;
      if (cond === undefined || cond === typeName || cond === 'Node') {
        Object.assign(result, execute(sel.selectionSet, typeName, value, ctx));
      }
      continue;
    }
    const fieldName = sel.name;
    const key = sel.alias || fieldName;
    if (fieldName === '__typename') {
      result[key] = typeName;
      continue;
    }
    const table = resolvers[typeName];
    const resolver = table ? table[fieldName] : undefined;
    if (!resolver) {
      ctx.errors.push({ message: 'Cannot query field "' + fieldName + '" on type "' + typeName + '".' });
      result[key] = null;
      continue;
    }
    let v: any;
    try {
      v = resolver(value, resolveArgs(sel.args || {}, ctx), ctx);
    } catch (e: any) {
      ctx.errors.push({ message: String((e && e.message) || e) });
      v = null;
    }
    if (sel.selectionSet && v !== null && v !== undefined) {
      if (Array.isArray(v)) {
        result[key] = v.map((item) =>
          item === null || item === undefined
            ? null
            : execute(sel.selectionSet!, item.__typename || typeName, item, ctx),
        );
      } else if (typeof v === 'object') {
        result[key] = execute(sel.selectionSet, v.__typename || typeName, v, ctx);
      } else {
        result[key] = v;
      }
    } else {
      result[key] = v;
    }
  }
  return result;
}

export function createGraphqlHandler(store: any, viewerLogin?: string, shared?: any) {
  const resolvedViewer = viewerLogin || process.env.MAKEFUN_VIEWER_LOGIN || 'adaiversen';

  return async function handler(req: GraphqlRequest): Promise<GraphqlResponse | null> {
    const method = (req && req.method ? req.method : 'GET').toUpperCase();
    const segments = (req && req.segments) || [];
    const headers = (req && req.headers) || {};
    const bodyText = (req && req.body) || '';

    // Only the GraphQL surface lives under /api/graphql; anything else is not ours.
    if (segments.length < PREFIX.length || segments[0] !== PREFIX[0] || segments[1] !== PREFIX[1]) {
      return null;
    }
    if (method !== 'POST') return null;

    if (!checkAuth(headers)) {
      return makeResponse(401, { data: null, errors: [{ message: 'Bad credentials' }] });
    }

    let parsed: any;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return makeResponse(400, { data: null, errors: [{ message: 'Invalid JSON' }] });
    }

    // Resolve the shared git state lazily so this surface always observes the same
    // branches/files/objects the REST surface created, regardless of build order.
    const storeRef: any = shared && shared.store ? shared.store : store;
    const branchFiles: Map<string, Map<string, { content: string; oid: string }>> =
      shared && shared.branchFiles ? shared.branchFiles : new Map();
    const branchCommits: Map<string, string[]> =
      shared && shared.branchCommits ? shared.branchCommits : new Map();
    const objects: any = shared && shared.objects ? shared.objects : createObjectStore();

    // Execute one operation document and return its answer payload ({ data } plus an
    // errors array when anything failed).
    const executeOperation = (op: any): Record<string, any> => {
      const variables: Record<string, any> =
        op && op.variables && typeof op.variables === 'object' && !Array.isArray(op.variables)
          ? op.variables
          : {};

      let doc: { selectionSet: any[]; fragments: Record<string, any> };
      try {
        doc = parseGraphql(op.query);
      } catch (e: any) {
        return {
          data: null,
          errors: [{ message: 'Syntax error: ' + String((e && e.message) || e) }],
        };
      }

      const ctx: Ctx = {
        store: storeRef,
        viewer: resolvedViewer,
        branchFiles,
        branchCommits,
        objects,
        fragments: doc.fragments,
        errors: [],
        variables,
      };

      // Validate the root fields before executing: an unknown root field is a
      // validation error, answered as HTTP 200 with an errors array.
      const queryTable = resolvers['Query'];
      let unknownRoot: string | null = null;
      for (const sel of doc.selectionSet) {
        if (sel.kind === 'field' && sel.name !== '__typename' && !queryTable[sel.name]) {
          unknownRoot = sel.name;
          break;
        }
      }

      let data: any;
      if (unknownRoot !== null) {
        data = null;
        ctx.errors.push({ message: 'Cannot query field "' + unknownRoot + '" on type "Query".' });
      } else {
        data = execute(doc.selectionSet, 'Query', {}, ctx);
      }

      const payload: Record<string, any> = { data };
      if (ctx.errors.length > 0) payload.errors = ctx.errors;
      return payload;
    };

    // A batched request body is a list of operation documents: execute each one in
    // order and answer them as a list in the same order. A single operation document
    // (not a list) keeps the single-answer behaviour exactly as before.
    if (Array.isArray(parsed)) {
      const answers: Record<string, any>[] = [];
      for (const op of parsed) {
        if (!op || typeof op.query !== 'string' || op.query.trim() === '') {
          answers.push({ data: null, errors: [{ message: 'Invalid JSON' }] });
        } else {
          answers.push(executeOperation(op));
        }
      }
      return makeResponse(200, answers);
    }

    if (!parsed || typeof parsed.query !== 'string' || parsed.query.trim() === '') {
      return makeResponse(400, { data: null, errors: [{ message: 'Invalid JSON' }] });
    }

    return makeResponse(200, executeOperation(parsed));
  };
}

export default createGraphqlHandler;
