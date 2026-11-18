// lib/store.ts
// In-memory store for the git forge. One process, no dependencies, no disk.
// Owned by app.ts and injected into every layer; no layer reaches around it.

export interface RepoLabel {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  issue_number: number;
  body: string;
  user?: string;
  created_at: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  user?: string;
  created_at: string;
  updated_at: string;
  comments: Comment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  head: string;
  base: string;
  merged: boolean;
  user?: string;
  created_at: string;
  updated_at: string;
  merged_at?: string;
  merge_commit_sha?: string;
}

export interface RepoFile {
  content: string;
  oid: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string; // login
  full_name: string;
  private: boolean;
  description: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
  issues: Issue[];
  pulls: Pull[];
  labels: RepoLabel[];
  comments: Comment[];
  branches: Map<string, string>; // branch name -> commit oid
  files: Map<string, RepoFile>; // path -> { content, oid }
}

export interface CreateRepoOptions {
  description?: string;
  private?: boolean;
  default_branch?: string;
}

export interface IssueFields {
  title: string;
  body?: string;
  labels?: string[];
  user?: string;
}

export interface IssueFilters {
  state?: "open" | "closed" | "all";
  labels?: string[];
}

export interface PullFields {
  title: string;
  body?: string;
  head: string;
  base: string;
  user?: string;
}

export interface PullFilters {
  state?: "open" | "closed" | "all";
}

function now(): string {
  return new Date().toISOString();
}

export function createStore() {
  const repos = new Map<string, Repo>();
  let repoSeq = 0;
  let issueSeq = 0;
  let pullSeq = 0;
  let commentSeq = 0;

  function keyOf(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  // Resolve a repo argument that may be a "owner/name" key, or a Repo object.
  function resolve(repo: Repo | string): Repo | null {
    if (!repo) return null;
    if (typeof repo === "string") return repos.get(repo) ?? null;
    const key = repo.full_name ?? keyOf(repo.owner, repo.name);
    return repos.get(key) ?? null;
  }

  function createRepo(owner: string, name: string, options: CreateRepoOptions = {}): Repo {
    const key = keyOf(owner, name);
    const existing = repos.get(key);
    if (existing) return existing; // idempotent
    const timestamp = now();
    const repo: Repo = {
      id: ++repoSeq,
      name,
      owner,
      full_name: key,
      private: options.private ?? false,
      description: options.description ?? "",
      default_branch: options.default_branch ?? "main",
      created_at: timestamp,
      updated_at: timestamp,
      issues: [],
      pulls: [],
      labels: [],
      comments: [],
      branches: new Map(),
      files: new Map(),
    };
    repos.set(key, repo);
    return repo;
  }

  function getRepo(owner: string, name: string): Repo | null {
    return repos.get(keyOf(owner, name)) ?? null;
  }

  function listRepos(filter?: { owner?: string }): Repo[] {
    const all = Array.from(repos.values());
    if (filter?.owner) return all.filter((r) => r.owner === filter.owner);
    return all;
  }

  function createIssue(repo: Repo | string, fields: IssueFields): Issue | null {
    const r = resolve(repo);
    if (!r) return null;
    const timestamp = now();
    const issue: Issue = {
      number: ++issueSeq,
      title: fields.title,
      body: fields.body ?? "",
      state: "open",
      labels: fields.labels ? [...fields.labels] : [],
      user: fields.user,
      created_at: timestamp,
      updated_at: timestamp,
      comments: [],
    };
    r.issues.push(issue);
    r.updated_at = timestamp;
    return issue;
  }

  function getIssue(repo: Repo | string, number: number): Issue | null {
    const r = resolve(repo);
    if (!r) return null;
    return r.issues.find((i) => i.number === number) ?? null;
  }

  function listIssues(repo: Repo | string, filters: IssueFilters = {}): Issue[] {
    const r = resolve(repo);
    if (!r) return [];
    let items = r.issues;
    const state = filters.state ?? "all";
    if (state !== "all") items = items.filter((i) => i.state === state);
    if (filters.labels && filters.labels.length > 0) {
      items = items.filter((i) => filters.labels!.every((l) => i.labels.includes(l)));
    }
    return items;
  }

  function updateIssue(
    repo: Repo | string,
    number: number,
    fields: Partial<IssueFields> & { state?: "open" | "closed" },
  ): Issue | null {
    const r = resolve(repo);
    if (!r) return null;
    const issue = r.issues.find((i) => i.number === number);
    if (!issue) return null;
    if (fields.title !== undefined) issue.title = fields.title;
    if (fields.body !== undefined) issue.body = fields.body;
    if (fields.state !== undefined) issue.state = fields.state;
    if (fields.labels !== undefined) issue.labels = [...fields.labels];
    if (fields.user !== undefined) issue.user = fields.user;
    issue.updated_at = now();
    r.updated_at = issue.updated_at;
    return issue;
  }

  function createComment(
    repo: Repo | string,
    issueNumber: number,
    body: string,
    user?: string,
  ): Comment | null {
    const r = resolve(repo);
    if (!r) return null;
    const issue = r.issues.find((i) => i.number === issueNumber);
    if (!issue) return null;
    const comment: Comment = {
      id: ++commentSeq,
      issue_number: issueNumber,
      body,
      user,
      created_at: now(),
    };
    issue.comments.push(comment);
    r.comments.push(comment);
    return comment;
  }

  function listComments(repo: Repo | string, issueNumber: number): Comment[] {
    const r = resolve(repo);
    if (!r) return [];
    const issue = r.issues.find((i) => i.number === issueNumber);
    return issue ? [...issue.comments] : [];
  }

  function createLabel(repo: Repo | string, name: string, color: string): RepoLabel | null {
    const r = resolve(repo);
    if (!r) return null;
    const existing = r.labels.find((l) => l.name === name);
    if (existing) return existing; // idempotent
    const label: RepoLabel = { name, color };
    r.labels.push(label);
    return label;
  }

  function listLabels(repo: Repo | string): RepoLabel[] {
    const r = resolve(repo);
    return r ? [...r.labels] : [];
  }

  function createPull(repo: Repo | string, fields: PullFields): Pull | null {
    const r = resolve(repo);
    if (!r) return null;
    const timestamp = now();
    const pull: Pull = {
      number: ++pullSeq,
      title: fields.title,
      body: fields.body ?? "",
      state: "open",
      head: fields.head,
      base: fields.base,
      merged: false,
      user: fields.user,
      created_at: timestamp,
      updated_at: timestamp,
    };
    r.pulls.push(pull);
    r.updated_at = timestamp;
    return pull;
  }

  function getPull(repo: Repo | string, number: number): Pull | null {
    const r = resolve(repo);
    if (!r) return null;
    return r.pulls.find((p) => p.number === number) ?? null;
  }

  function listPulls(repo: Repo | string, filters: PullFilters = {}): Pull[] {
    const r = resolve(repo);
    if (!r) return [];
    const state = filters.state ?? "all";
    if (state !== "all") return r.pulls.filter((p) => p.state === state);
    return r.pulls;
  }

  function updatePull(
    repo: Repo | string,
    number: number,
    fields: Partial<PullFields> & {
      state?: "open" | "closed";
      merged?: boolean;
      merged_at?: string;
      merge_commit_sha?: string;
    },
  ): Pull | null {
    const r = resolve(repo);
    if (!r) return null;
    const pull = r.pulls.find((p) => p.number === number);
    if (!pull) return null;
    if (fields.title !== undefined) pull.title = fields.title;
    if (fields.body !== undefined) pull.body = fields.body;
    if (fields.state !== undefined) pull.state = fields.state;
    if (fields.head !== undefined) pull.head = fields.head;
    if (fields.base !== undefined) pull.base = fields.base;
    if (fields.merged !== undefined) pull.merged = fields.merged;
    if (fields.user !== undefined) pull.user = fields.user;
    if (fields.merged_at !== undefined) pull.merged_at = fields.merged_at;
    if (fields.merge_commit_sha !== undefined) pull.merge_commit_sha = fields.merge_commit_sha;
    pull.updated_at = now();
    r.updated_at = pull.updated_at;
    return pull;
  }

  return {
    repos,
    createRepo,
    getRepo,
    listRepos,
    createIssue,
    getIssue,
    listIssues,
    updateIssue,
    createComment,
    listComments,
    createLabel,
    listLabels,
    createPull,
    getPull,
    listPulls,
    updatePull,
  };
}
