// lib/objects.ts — minimal git object helpers.
// No dependencies other than node:crypto.

import { createHash } from 'node:crypto';

/** Returns the lowercase hex SHA-1 of a buffer. */
export function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

/** A git blob built from text content. */
export interface BlobResult {
  oid: string;
  raw: Buffer;
}

/**
 * Builds a git blob object from text content.
 * Raw bytes: ASCII header `blob`, a space, the byte length,
 * a NUL byte, then the content bytes.
 */
export function buildBlob(content: string | Buffer): BlobResult {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const header = Buffer.from(`blob ${body.length}\0`, 'utf8');
  const raw = Buffer.concat([header, body]);
  return { oid: sha1(raw), raw };
}

/** A single tree entry. */
export interface TreeEntry {
  mode: string; // e.g. '100644'
  name: string;
  oid: string; // hex oid
}

export interface TreeResult {
  oid: string;
  raw: Buffer;
}

/**
 * Builds a git tree object from a list of entries.
 * Raw bytes: header `tree`, a space, the length, a NUL byte, then per entry:
 * the mode in ASCII, a space, the name, a NUL byte, then the 20 raw bytes of the oid.
 */
export function buildTree(entries: TreeEntry[]): TreeResult {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  const body = Buffer.concat(parts);
  const header = Buffer.from(`tree ${body.length}\0`, 'utf8');
  const raw = Buffer.concat([header, body]);
  return { oid: sha1(raw), raw };
}

/** A person: name, email, and Unix epoch seconds. */
export interface Person {
  name: string;
  email: string;
  epoch: number;
}

export interface CommitOptions {
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
}

export interface CommitResult {
  oid: string;
  raw: Buffer;
}

/**
 * Builds a git commit object.
 * Text lines: tree, one parent line per parent, author line with epoch and
 * a +0000 timezone, committer line, a blank line, then the message.
 */
export function buildCommit(opts: CommitOptions): CommitResult {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(
    `author ${opts.author.name} <${opts.author.email}> ${opts.author.epoch} +0000`,
  );
  lines.push(
    `committer ${opts.committer.name} <${opts.committer.email}> ${opts.committer.epoch} +0000`,
  );
  lines.push('');
  lines.push(opts.message);
  const text = Buffer.from(lines.join('\n'), 'utf8');
  const header = Buffer.from(`commit ${text.length}\0`, 'utf8');
  const raw = Buffer.concat([header, text]);
  return { oid: sha1(raw), raw };
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
}

function parsePerson(line: string): Person {
  const lt = line.indexOf('<');
  const gt = line.indexOf('>', lt);
  const name = line.slice(0, lt).trim();
  const email = line.slice(lt + 1, gt);
  const epoch = Number(line.slice(gt + 1).trim().split(' ')[0]);
  return { name, email, epoch };
}

/** Parses a git commit's raw bytes back into its fields. */
export function parseCommit(raw: Buffer): ParsedCommit {
  const nul = raw.indexOf(0);
  const text =
    nul === -1 ? raw.toString('utf8') : raw.subarray(nul + 1).toString('utf8');
  const sep = text.indexOf('\n\n');
  const header = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? '' : text.slice(sep + 2);

  let tree = '';
  const parents: string[] = [];
  let author: Person | null = null;
  let committer: Person | null = null;

  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parsePerson(line.slice(7));
    else if (line.startsWith('committer ')) committer = parsePerson(line.slice(10));
  }

  if (!author || !committer) {
    throw new Error('commit is missing author or committer');
  }
  return { tree, parents, author, committer, message };
}

/** A stored object: its type and raw bytes. */
export interface StoredObject {
  type: 'blob' | 'tree' | 'commit';
  raw: Buffer;
}

/** A tiny in-memory git object store keyed by oid. */
export interface ObjectStore {
  put(oid: string, obj: StoredObject): void;
  get(oid: string): StoredObject | undefined;
}

/** Factory for a tiny in-memory object store. */
export function createObjectStore(): ObjectStore {
  const objects = new Map<string, StoredObject>();
  return {
    put(oid: string, obj: StoredObject): void {
      objects.set(oid, obj);
    },
    get(oid: string): StoredObject | undefined {
      return objects.get(oid);
    },
  };
}
