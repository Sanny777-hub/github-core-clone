// lib/git.ts — minimal git wire-format codec.
// Covers two pieces of the git smart HTTP surface:
//   1. the packet-line codec (encode/decode),
//   2. the packfile writer and reader (plain objects only, never deltas).
//
// Depends only on node:zlib and the object store module (lib/objects.ts),
// from which it takes the store and the sha1 helper.

import { deflateSync, inflateSync } from 'node:zlib';
import { parseCommit, sha1 } from './objects.ts';
import type { ObjectStore, StoredObject } from './objects.ts';
import type { createStore, Repo } from './store.ts';

// ---------------------------------------------------------------------------
// Packet lines
// ---------------------------------------------------------------------------

/** The largest total length a packet line may have, per the git protocol. */
export const MAX_PACKET_LENGTH = 65520;
/** The largest data payload a packet line may carry (MAX_PACKET_LENGTH - 4). */
export const MAX_PACKET_PAYLOAD = MAX_PACKET_LENGTH - 4;

/**
 * A decoded packet line. Data packets carry their payload; the three special
 * packet types carry none.
 */
export type PacketLine =
  | { type: 'flush' }
  | { type: 'delimiter' }
  | { type: 'response-end' }
  | { type: 'data'; data: Buffer };

/** Result of decoding a single packet line from a buffer. */
export interface DecodedPacket {
  packet: PacketLine;
  /** Number of bytes consumed from the buffer by this packet line. */
  consumed: number;
}

function packetLenHex(len: number): string {
  return len.toString(16).padStart(4, '0');
}

function parsePacketLen(hex: string): number {
  if (!/^[0-9a-f]{4}$/.test(hex)) {
    throw new Error(`invalid packet length: ${JSON.stringify(hex)}`);
  }
  return parseInt(hex, 16);
}

/** A tiny packet-line codec, bound to no particular side. */
export interface PacketCodec {
  /** Encodes one data packet line: `hex(len+4)` followed by the payload. */
  encode(data: Buffer | string): Buffer;
  /** The flush packet: `0000`. */
  flush(): Buffer;
  /** The delimiter packet: `0001`. */
  delimiter(): Buffer;
  /** The response-end packet: `0002`. */
  responseEnd(): Buffer;
  /** Decodes a single packet line starting at `offset`. */
  decode(buf: Buffer, offset?: number): DecodedPacket;
  /** Decodes every packet line in `buf`. */
  decodeAll(buf: Buffer): PacketLine[];
}

function createPacketCodec(): PacketCodec {
  function encode(data: Buffer | string): Buffer {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    if (body.length > MAX_PACKET_PAYLOAD) {
      throw new Error(`packet payload too large: ${body.length} bytes`);
    }
    return Buffer.concat([
      Buffer.from(packetLenHex(body.length + 4), 'utf8'),
      body,
    ]);
  }

  function special(hex: string): Buffer {
    return Buffer.from(hex, 'utf8');
  }

  function decode(buf: Buffer, offset = 0): DecodedPacket {
    if (offset + 4 > buf.length) {
      throw new Error('truncated packet header');
    }
    const len = parsePacketLen(buf.subarray(offset, offset + 4).toString('utf8'));
    if (len === 0) return { packet: { type: 'flush' }, consumed: 4 };
    if (len === 1) return { packet: { type: 'delimiter' }, consumed: 4 };
    if (len === 2) return { packet: { type: 'response-end' }, consumed: 4 };
    if (len < 4 || len > MAX_PACKET_LENGTH) {
      throw new Error(`invalid packet length: ${len}`);
    }
    if (offset + len > buf.length) {
      throw new Error('truncated packet data');
    }
    return {
      packet: {
        type: 'data',
        data: buf.subarray(offset + 4, offset + len),
      },
      consumed: len,
    };
  }

  function decodeAll(buf: Buffer): PacketLine[] {
    const lines: PacketLine[] = [];
    let offset = 0;
    while (offset < buf.length) {
      const { packet, consumed } = decode(buf, offset);
      lines.push(packet);
      offset += consumed;
    }
    return lines;
  }

  return { encode, flush: () => special('0000'), delimiter: () => special('0001'), responseEnd: () => special('0002'), decode, decodeAll };
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

/** Object type numbers as encoded in a packfile object header. */
const TYPE_NUM: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const TYPE_NAME: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
/** Delta types are rejected: this codec only ever writes/reads plain objects. */
const DELTA_TYPES = new Set([6, 7]);

/**
 * Encodes the variable-length object header: the type in bits 6-4 of the first
 * byte, the size in the low 4 bits of the first byte followed by 7 bits per
 * subsequent byte, least-significant bits first.
 */
function encodeObjectHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  if (rest > 0) {
    bytes.push(first | 0x80);
    while (rest > 0) {
      let b = rest & 0x7f;
      rest = Math.floor(rest / 128);
      if (rest > 0) b |= 0x80;
      bytes.push(b);
    }
  } else {
    bytes.push(first);
  }
  return Buffer.from(bytes);
}

/**
 * Decodes a variable-length object header at `pos`, returning the type number,
 * the size, and how many bytes the header occupied.
 */
function decodeObjectHeader(
  buf: Buffer,
  pos: number,
): { typeNum: number; size: number; headerLen: number } {
  const start = pos;
  let byte = buf[pos];
  const typeNum = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  pos++;
  while (byte & 0x80) {
    byte = buf[pos];
    size += (byte & 0x7f) * Math.pow(2, shift);
    shift += 7;
    pos++;
  }
  return { typeNum, size, headerLen: pos - start };
}

/**
 * Returns the length in bytes of the zlib stream that starts at `pos`.
 * `inflateSync` stops at the end of the first complete stream and ignores
 * trailing bytes, so a stream of length L inflates successfully for every
 * prefix of length >= L and throws ("unexpected end of file") for every
 * shorter prefix. That makes "prefix inflates cleanly" a monotonic predicate,
 * so the exact compressed length is found by binary search.
 */
function compressedLength(buf: Buffer, pos: number): number {
  const remaining = buf.length - pos;
  if (remaining <= 0) throw new Error('truncated object data');
  const canInflate = (len: number): boolean => {
    try {
      inflateSync(buf.subarray(pos, pos + len));
      return true;
    } catch {
      return false;
    }
  };
  if (!canInflate(remaining)) throw new Error('invalid zlib stream');
  let lo = 1;
  let hi = remaining;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (canInflate(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Splits a full object's raw bytes (`<type> <len>\0<body>`) into its type and
 * its content (the body only). Packfiles store content only — the type and
 * size live in the packfile object header — so the writer strips this prefix.
 */
function splitObjectRaw(raw: Buffer): { type: string; content: Buffer } {
  const nul = raw.indexOf(0);
  if (nul === -1) throw new Error('malformed object raw bytes');
  const header = raw.subarray(0, nul).toString('utf8');
  const space = header.indexOf(' ');
  if (space === -1) throw new Error('malformed object header');
  const type = header.slice(0, space);
  const len = Number(header.slice(space + 1));
  const content = raw.subarray(nul + 1);
  if (content.length !== len) {
    throw new Error(`object length mismatch: header says ${len}, got ${content.length}`);
  }
  return { type, content };
}

/** Rebuilds a full object's raw bytes from its type and content. */
function reassembleObject(type: string, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${content.length}\0`, 'utf8'), content]);
}

/** An object as read back from a packfile: its type, recomputed id, and raw bytes. */
export interface PackedObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  oid: string;
  raw: Buffer;
}

/** The packfile writer and reader. */
export interface PackfileCodec {
  /**
   * Writes a packfile containing the given object ids as plain objects, looked
   * up in the store, ending with a SHA-1 checksum of everything before it.
   */
  write(oids: string[]): Buffer;
  /**
   * Reads a packfile: validates the header, inflates each plain object,
   * recomputes each object id, and verifies the trailing checksum.
   */
  read(pack: Buffer): PackedObject[];
}

function createPackfileCodec(store: ObjectStore): PackfileCodec {
  function write(oids: string[]): Buffer {
    const chunks: Buffer[] = [];
    const header = Buffer.alloc(12);
    header.write('PACK', 0, 'utf8');
    header.writeUInt32BE(2, 4); // packfile version 2
    header.writeUInt32BE(oids.length, 8); // object count
    chunks.push(header);

    for (const oid of oids) {
      const obj = store.get(oid);
      if (!obj) throw new Error(`unknown object: ${oid}`);
      const typeNum = TYPE_NUM[obj.type];
      if (typeNum === undefined) {
        throw new Error(`unsupported object type: ${obj.type}`);
      }
      // Packfiles store the object content only; type and size are in the header.
      const { content } = splitObjectRaw(obj.raw);
      chunks.push(encodeObjectHeader(typeNum, content.length));
      chunks.push(deflateSync(content));
    }

    const body = Buffer.concat(chunks);
    return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
  }

  function read(pack: Buffer): PackedObject[] {
    if (pack.length < 32) throw new Error('packfile too small');
    if (pack.subarray(0, 4).toString('utf8') !== 'PACK') {
      throw new Error('missing PACK signature');
    }
    if (pack.readUInt32BE(4) !== 2) {
      throw new Error('unsupported packfile version');
    }
    const count = pack.readUInt32BE(8);

    const objects: PackedObject[] = [];
    let pos = 12;
    for (let i = 0; i < count; i++) {
      const { typeNum, size, headerLen } = decodeObjectHeader(pack, pos);
      pos += headerLen;
      if (DELTA_TYPES.has(typeNum)) {
        throw new Error(`delta objects not supported (type ${typeNum})`);
      }
      const type = TYPE_NAME[typeNum];
      if (type === undefined) {
        throw new Error(`unknown object type: ${typeNum}`);
      }
      const clen = compressedLength(pack, pos);
      const content = inflateSync(pack.subarray(pos, pos + clen));
      if (content.length !== size) {
        throw new Error(`object size mismatch: expected ${size}, got ${content.length}`);
      }
      pos += clen;
      // Rebuild the full object bytes (type + length header + content) so the
      // object matches what the store holds and its id recomputes correctly.
      const raw = reassembleObject(type, content);
      objects.push({ type: type as PackedObject['type'], oid: sha1(raw), raw });
    }

    const expected = pack.subarray(pack.length - 20).toString('hex');
    const actual = sha1(pack.subarray(0, pack.length - 20));
    if (expected !== actual) {
      throw new Error(`packfile checksum mismatch: expected ${expected}, got ${actual}`);
    }
    return objects;
  }

  return { write, read };
}

// ---------------------------------------------------------------------------
// Ref advertisement (upload-pack, info/refs)
// ---------------------------------------------------------------------------

/** The all-zero SHA-1 object id, used for the empty-repository pseudo-reference. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Name this implementation reports in the `agent` capability. */
export const AGENT_NAME = 'github-core';

/**
 * The fetch capabilities a v0 upload-pack advertisement carries on the first
 * ref line (and on the empty-repository pseudo-ref): side-band-64k so the
 * packfile is framed on channel one, shallow so depth-limited clones are
 * allowed, multi_ack_detailed/thin-pack/ofs-delta as the clients expect them.
 */
const FETCH_CAPS = 'side-band-64k shallow multi_ack_detailed thin-pack ofs-delta';

/**
 * A tag reference held in the shared state. `oid` is the object the reference
 * points at (normally an annotated tag object); `peeled` is the commit object
 * id that annotated tag resolves to, advertised as a `^{}` line.
 */
export interface TagRef {
  oid: string;
  peeled: string;
}

/**
 * Process-wide state that outlives a single request. Tag references live here
 * rather than on a repository because a tag is pushed after its repository
 * already exists; the map is keyed by repo key ("owner/name") and then by tag
 * name, so a tag pushed later is advertised with the commit it peels to.
 */
export interface SharedState {
  refs: Map<string, Map<string, TagRef>>;
}

/** The repository store the advertisement reads branches and the default branch from. */
export type RepoStore = ReturnType<typeof createStore>;

/** One reference to advertise: the object id and the full ref name. */
interface AdvertisedRef {
  oid: string;
  refname: string;
}

function createRefAdvert(store: RepoStore, viewer: string, shared: SharedState) {
  // Reserved for per-viewer behavior once the upload-pack surface is wired.
  void viewer;

  /** Builds the ordered ref list (HEAD, branches, tags) for one repository. */
  function buildRefs(repo: Repo): AdvertisedRef[] {
    const refs: AdvertisedRef[] = [];
    if (repo.branches.size > 0) {
      const defaultOid =
        repo.branches.get(repo.default_branch) ?? [...repo.branches.values()][0];
      refs.push({ oid: defaultOid, refname: 'HEAD' });
      const branches = [...repo.branches.entries()].sort((a, b) =>
        a[0].localeCompare(b[0]),
      );
      for (const [branch, oid] of branches) {
        refs.push({ oid, refname: `refs/heads/${branch}` });
      }
    }
    const repoRefs = shared.refs.get(`${repo.owner}/${repo.name}`);
    if (repoRefs) {
      const tags = [...repoRefs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      for (const [tagName, tag] of tags) {
        const full = tagName.startsWith('refs/tags/') ? tagName : `refs/tags/${tagName}`;
        refs.push({ oid: tag.oid, refname: full });
        if (tag.peeled) refs.push({ oid: tag.peeled, refname: `${full}^{}` });
      }
    }
    return refs;
  }

  /** Protocol v2 advertisement: version, capabilities, refs. */
  function advertiseV2(refs: AdvertisedRef[]): Buffer {
    const packet = createPacketCodec();
    const out: Buffer[] = [
      packet.encode('version 2'),
      packet.encode('ls-refs'),
      packet.encode('fetch=shallow'),
      packet.encode('object-format=sha1'),
      packet.encode(`agent=${AGENT_NAME}`),
      packet.flush(),
    ];
    if (refs.length === 0) {
      out.push(packet.encode(`${ZERO_OID} capabilities^{}`));
    } else {
      for (const ref of refs) out.push(packet.encode(`${ref.oid} ${ref.refname}`));
    }
    out.push(packet.flush());
    return Buffer.concat(out);
  }

  /** Protocol v0 advertisement: service preamble, then refs with capabilities. */
  function advertiseV0(repo: Repo, refs: AdvertisedRef[]): Buffer {
    const packet = createPacketCodec();
    // The smart-HTTP info/refs answer leads with the service preamble line and
    // a flush packet, matching the receive-pack advertisement shape.
    const out: Buffer[] = [
      packet.encode('# service=git-upload-pack\n'),
      packet.flush(),
    ];
    if (refs.length === 0) {
      out.push(packet.encode(`${ZERO_OID} capabilities^{}\0agent=${AGENT_NAME} ${FETCH_CAPS}`));
      out.push(packet.flush());
      return Buffer.concat(out);
    }
    const first = refs[0];
    const caps = [
      `agent=${AGENT_NAME}`,
      `symref=HEAD:refs/heads/${repo.default_branch}`,
      FETCH_CAPS,
    ].join(' ');
    out.push(packet.encode(`${first.oid} ${first.refname}\0${caps}`));
    for (const ref of refs.slice(1)) out.push(packet.encode(`${ref.oid} ${ref.refname}`));
    out.push(packet.flush());
    return Buffer.concat(out);
  }

  /**
   * Returns the upload-pack ref advertisement for `owner/name` at the given
   * protocol version (2 or 0), or null when the repository does not exist.
   */
  function advertise(owner: string, name: string, version: number): Buffer | null {
    const repo = store.getRepo(owner, name);
    if (!repo) return null;
    const refs = buildRefs(repo);
    return version === 2 ? advertiseV2(refs) : advertiseV0(repo, refs);
  }

  return advertise;
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

/** Parsed arguments of a protocol-v2 ls-refs request. */
export interface LsRefsRequest {
  command: string;
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** One reference in a ls-refs answer: the name, the object id, and optional extras. */
interface LsRefLine {
  name: string;
  oid: string;
  /** The commit an annotated tag peels to, advertised as a `peeled:` attribute. */
  peel?: string;
  /** The symbolic target of HEAD, advertised as a `symref-target:` attribute. */
  symref?: string;
  /** True for the unborn HEAD of a repository that has no commits. */
  unborn?: boolean;
}

/** Decodes the packet lines of a git-upload-pack request into ls-refs arguments. */
function parseLsRefsRequest(body: Buffer): LsRefsRequest {
  const request: LsRefsRequest = {
    command: '',
    peel: false,
    symrefs: false,
    unborn: false,
    prefixes: [],
  };
  const packets = createPacketCodec().decodeAll(body);
  for (const packet of packets) {
    if (packet.type !== 'data') continue;
    const line = packet.data.toString('utf8').replace(/[\r\n]+$/, '');
    if (line.startsWith('command=')) {
      request.command = line.slice('command='.length);
    } else if (line === 'peel') {
      request.peel = true;
    } else if (line === 'symrefs') {
      request.symrefs = true;
    } else if (line === 'unborn') {
      request.unborn = true;
    } else if (line.startsWith('ref-prefix ')) {
      request.prefixes.push(line.slice('ref-prefix '.length));
    }
    // agent=..., object-format=..., server-option and other capabilities are ignored.
  }
  return request;
}

/** Builds the ordered ls-refs line list (HEAD, branches, tags) for one repository. */
function buildLsRefLines(repo: Repo, shared: SharedState): LsRefLine[] {
  const lines: LsRefLine[] = [];
  const symref = `refs/heads/${repo.default_branch}`;
  if (repo.branches.size > 0) {
    const defaultOid =
      repo.branches.get(repo.default_branch) ?? [...repo.branches.values()][0];
    lines.push({ name: 'HEAD', oid: defaultOid, symref });
    const branches = [...repo.branches.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [branch, oid] of branches) {
      lines.push({ name: `refs/heads/${branch}`, oid });
    }
  } else {
    lines.push({ name: 'HEAD', oid: ZERO_OID, symref, unborn: true });
  }
  const repoRefs = shared.refs.get(`${repo.owner}/${repo.name}`);
  if (repoRefs) {
    const tags = [...repoRefs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [tagName, tag] of tags) {
      const full = tagName.startsWith('refs/tags/') ? tagName : `refs/tags/${tagName}`;
      lines.push({ name: full, oid: tag.oid, peel: tag.peeled });
    }
  }
  return lines;
}

function createLsRefs(store: RepoStore, viewer: string, shared: SharedState) {
  void viewer;

  /**
   * Answers a protocol-v2 ls-refs request for `owner/name`, returning the
   * response packet lines, or null when the repository does not exist. The
   * answer honours the ref-prefix filter and the peel, symrefs and unborn
   * flags, mirroring the git upload-pack wire format.
   */
  function lsRefs(owner: string, name: string, request: LsRefsRequest): Buffer | null {
    const repo = store.getRepo(owner, name);
    if (!repo) return null;
    const all = buildLsRefLines(repo, shared);
    const filtered =
      request.prefixes.length > 0
        ? all.filter((ref) => request.prefixes.some((prefix) => ref.name.startsWith(prefix)))
        : all;
    const packet = createPacketCodec();
    const out: Buffer[] = [];
    for (const ref of filtered) {
      if (ref.unborn) {
        if (!request.unborn) continue;
        let line = 'unborn HEAD';
        if (request.symrefs && ref.symref) line += ` symref-target:${ref.symref}`;
        out.push(packet.encode(line));
      } else {
        let line = `${ref.oid} ${ref.name}`;
        if (request.symrefs && ref.name === 'HEAD' && ref.symref) {
          line += ` symref-target:${ref.symref}`;
        }
        if (request.peel && ref.peel) line += ` peeled:${ref.peel}`;
        out.push(packet.encode(line));
      }
    }
    out.push(packet.flush());
    return Buffer.concat(out);
  }

  return lsRefs;
}

// ---------------------------------------------------------------------------
// upload-pack fetch (protocol v0 and v2)
// ---------------------------------------------------------------------------

/** Parsed arguments of a fetch request, shared by protocol v0 and v2. */
export interface FetchRequest {
  /** The request command: 'fetch' for v2, '' for a plain v0 request. */
  command: string;
  /** Object ids the client wants (commits, tags, trees or blobs). */
  wants: string[];
  /** Commits the client already holds. */
  haves: string[];
  /** Boundaries the client already holds as shallow commits. */
  shallow: string[];
  /** The deepen value, or null for an unlimited fetch. */
  deepen: number | null;
  /** Whether the client ended negotiation (done). */
  done: boolean;
  /** A filter specification, ignored (no partial-clone support). */
  filter: string | null;
}

/**
 * Decodes a git-upload-pack request into its fetch arguments. Both protocol
 * versions speak the same want/have/shallow/deepen/done vocabulary: v2 wraps
 * the arguments in a `command=fetch` section behind a delimiter while v0 sends
 * them as one flat list. Capability lines (thin-pack, no-progress, ofs-delta,
 * agent=, object-format=, and v0 feature lists after a want) are ignored.
 */
function parseFetchRequest(body: Buffer): FetchRequest {
  const request: FetchRequest = {
    command: '',
    wants: [],
    haves: [],
    shallow: [],
    deepen: null,
    done: false,
    filter: null,
  };
  const packets = createPacketCodec().decodeAll(body);
  for (const packet of packets) {
    if (packet.type !== 'data') continue;
    const line = packet.data.toString('utf8').replace(/[\r\n]+$/, '');
    if (line.startsWith('command=')) {
      request.command = line.slice('command='.length);
    } else if (line.startsWith('want ')) {
      const oid = line.slice('want '.length).trim().split(' ')[0];
      if (oid) request.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice('have '.length).trim().split(' ')[0];
      if (oid) request.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice('shallow '.length).trim().split(' ')[0];
      if (oid) request.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const value = Number(line.slice('deepen '.length).trim());
      if (Number.isFinite(value) && value > 0) request.deepen = value;
    } else if (line === 'done') {
      request.done = true;
    } else if (line.startsWith('filter ')) {
      request.filter = line.slice('filter '.length).trim();
    }
    // agent=, object-format=, thin-pack, no-progress, ofs-delta and the other
    // capability lines are not part of the fetch negotiation.
  }
  return request;
}

/** A single tree entry as decoded from a tree object. */
interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Decodes a tree object's raw bytes into its entries. */
function parseTreeEntries(raw: Buffer): TreeEntry[] {
  const nul = raw.indexOf(0);
  const body = nul === -1 ? raw : raw.subarray(nul + 1);
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < body.length) {
    const space = body.indexOf(0x20, pos);
    if (space === -1) throw new Error('malformed tree entry: missing mode');
    const mode = body.subarray(pos, space).toString('utf8');
    const nulPos = body.indexOf(0, space + 1);
    if (nulPos === -1) throw new Error('malformed tree entry: missing name');
    const name = body.subarray(space + 1, nulPos).toString('utf8');
    if (nulPos + 21 > body.length) throw new Error('truncated tree entry');
    const oid = body.subarray(nulPos + 1, nulPos + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nulPos + 21;
  }
  return entries;
}

/** True for a tree entry that points at a subtree (not a blob or gitlink). */
function isSubtree(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Reads the object id an annotated tag points at, or null. */
function parseTagTarget(raw: Buffer): string | null {
  const nul = raw.indexOf(0);
  const text = nul === -1 ? raw.toString('utf8') : raw.subarray(nul + 1).toString('utf8');
  const match = /^object ([0-9a-f]{40})/.exec(text);
  return match ? match[1] : null;
}

/** The result of walking a fetch request against the object store. */
interface FetchWalk {
  /** Object ids to send, in a deterministic order. */
  oids: string[];
  /** New shallow boundary commits to announce. */
  shallow: string[];
  /** Shallow commits the client held that are no longer boundaries. */
  unshallow: string[];
  /** How many wanted objects actually exist in the store. */
  resolvedWants: number;
}

/** A loose view of a stored object (the store's type union is narrower than reality). */
type StoreObject = { type: string; raw: Buffer };

/**
 * Marks every object reachable from `seed` as held. A `have` commit brings its
 * whole closure (parents and trees); a shallow boundary brings its tree but
 * not its ancestors, because the client cut the history there.
 */
function markClosure(
  store: ObjectStore,
  seed: string,
  held: Set<string>,
  walkParents: boolean,
): void {
  const queue = [seed];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid) as StoreObject | undefined;
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.raw);
      queue.push(commit.tree);
      if (walkParents) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTreeEntries(object.raw)) {
        held.add(entry.oid);
        if (isSubtree(entry.mode)) queue.push(entry.oid);
      }
    }
  }
}

/**
 * Walks the objects a fetch must send: from each wanted commit through its
 * parents (down to the deepen boundary) and through its trees (recursing into
 * subtrees to collect every tree and blob), leaving out everything the client
 * already holds. The wanted commit at the deepen boundary is the new shallow
 * boundary; a shallow commit the client held that is now walked through is
 * reported as unshallow.
 */
function collectReachable(store: ObjectStore, request: FetchRequest): FetchWalk {
  const wants = [...new Set(request.wants)];
  const wantSet = new Set(wants);
  const limit = request.deepen ?? Infinity;

  // Everything the client already holds: the full closure of each `have`
  // commit, plus the tree (but not the ancestors) of each shallow boundary.
  const held = new Set<string>();
  const shallowBoundaries = new Set(request.shallow);
  for (const have of request.haves) {
    // A have that is also a shallow boundary only contributes itself and its
    // tree: the client cut the history there and does not hold the ancestors.
    markClosure(store, have, held, !shallowBoundaries.has(have));
  }
  for (const shallow of request.shallow) markClosure(store, shallow, held, false);

  const toSend = new Set<string>();
  const depth = new Map<string, number>();
  const queue: string[] = [];
  const walkedTrees = new Set<string>();
  const shallowOut = new Set<string>();
  const unshallowOut = new Set<string>();
  const shallowHeld = new Set(request.shallow);
  let resolvedWants = 0;

  /** Adds a tree and every object its entries reach (recursing into subtrees). */
  const walkTree = (oid: string): void => {
    if (walkedTrees.has(oid)) return;
    walkedTrees.add(oid);
    // The client already holds this tree: do not send it nor walk into it.
    if (held.has(oid)) return;
    const tree = store.get(oid) as StoreObject | undefined;
    if (!tree) return;
    toSend.add(oid);
    for (const entry of parseTreeEntries(tree.raw)) {
      // The client already holds this entry: do not send it nor recurse into it.
      if (held.has(entry.oid)) continue;
      if (isSubtree(entry.mode)) walkTree(entry.oid);
      else if (entry.mode !== '160000') toSend.add(entry.oid); // gitlinks are not fetched
    }
  };

  /** Schedules a commit for inclusion at a depth (depth 1 is the boundary). */
  const traverse = (oid: string, d: number): void => {
    if (d <= 0) return;
    const object = store.get(oid) as StoreObject | undefined;
    if (!object || object.type !== 'commit') return;
    if (held.has(oid) && !wantSet.has(oid)) return;
    if ((depth.get(oid) ?? -Infinity) >= d) return;
    depth.set(oid, d);
    queue.push(oid);
  };

  for (const want of wants) {
    const object = store.get(want) as StoreObject | undefined;
    if (!object) continue;
    resolvedWants += 1;
    if (object.type === 'commit') {
      traverse(want, limit);
    } else if (object.type === 'tag') {
      toSend.add(want);
      const target = parseTagTarget(object.raw);
      if (target) {
        const targetObject = store.get(target) as StoreObject | undefined;
        if (targetObject?.type === 'commit') traverse(target, limit);
        else if (targetObject?.type === 'tree') walkTree(target);
        else if (targetObject) toSend.add(target);
      }
    } else if (object.type === 'tree') {
      walkTree(want);
    } else {
      toSend.add(want);
    }
  }

  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const d = depth.get(oid) as number;
    const object = store.get(oid) as StoreObject | undefined;
    if (!object || object.type !== 'commit') continue;
    const isHeld = held.has(oid);
    const commit = parseCommit(object.raw);
    if (d > 1) {
      if (!isHeld) {
        toSend.add(oid);
        walkTree(commit.tree);
      }
      for (const parent of commit.parents) traverse(parent, d - 1);
      if (shallowHeld.has(oid)) unshallowOut.add(oid);
    } else {
      // depth 1 is the shallow boundary: it is sent (with its tree) unless the
      // client already holds it.
      if (!isHeld) {
        toSend.add(oid);
        walkTree(commit.tree);
        shallowOut.add(oid);
      }
    }
  }

  return {
    oids: [...toSend],
    shallow: [...shallowOut],
    unshallow: [...unshallowOut],
    resolvedWants,
  };
}

/** Encodes `data` as side-band packets on `band` (each under the packet cap). */
function sidebandChunks(packet: PacketCodec, band: number, data: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const size = 65000;
  for (let i = 0; i < data.length; i += size) {
    chunks.push(packet.encode(Buffer.concat([Buffer.from([band]), data.subarray(i, i + size)])));
  }
  if (chunks.length === 0) chunks.push(packet.encode(Buffer.from([band])));
  return chunks;
}

function createFetch(
  store: RepoStore,
  getObjects: () => ObjectStore,
  viewer: string,
  shared: SharedState,
) {
  void viewer;
  void shared;

  /**
   * Answers a git-upload-pack fetch for `owner/name` at protocol version 2 or 0,
   * or null when the repository does not exist. The answer announces the new
   * shallow boundaries (and unshallowed commits) and carries the wanted-but-
   * not-held objects as a packfile on side-band channel one, with progress text
   * on channel two. A fetch of an empty repository answers with no packfile.
   */
  function fetch(
    owner: string,
    name: string,
    request: FetchRequest,
    version: 0 | 2,
  ): Buffer | null {
    if (!store.getRepo(owner, name)) return null;
    // The real object store lives on the REST handler and is attached only after
    // its first request, so it is resolved here, at fetch time, not at build.
    const objects = getObjects();
    const packfile = createPackfileCodec(objects);
    const walk = collectReachable(objects, request);
    const packet = createPacketCodec();
    const out: Buffer[] = [];

    const shallowLines: string[] = [];
    for (const oid of walk.shallow) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of walk.unshallow) shallowLines.push(`unshallow ${oid}\n`);

    // An empty repository (no wanted object resolves) answers with no packfile.
    const pack = walk.resolvedWants > 0 ? packfile.write(walk.oids) : null;

    /** Emits the packfile on channel one and the progress text on channel two. */
    const emitPack = (): void => {
      if (!pack) return;
      if (walk.oids.length > 0) {
        const progress = Buffer.from(`Counting objects: ${walk.oids.length}, done.\n`, 'utf8');
        out.push(...sidebandChunks(packet, 2, progress));
      }
      out.push(...sidebandChunks(packet, 1, pack));
    };

    if (version === 2) {
      if (shallowLines.length > 0) {
        out.push(packet.encode('shallow-info\n'));
        for (const line of shallowLines) out.push(packet.encode(line));
        out.push(pack ? packet.delimiter() : packet.flush());
      }
      if (pack) {
        out.push(packet.encode('packfile\n'));
        emitPack();
      }
      out.push(packet.flush());
    } else {
      for (const line of shallowLines) out.push(packet.encode(line));
      if (shallowLines.length > 0) out.push(packet.flush());
      out.push(packet.encode('NAK\n'));
      emitPack();
      out.push(packet.flush());
    }
    return Buffer.concat(out);
  }

  return fetch;
}

// ---------------------------------------------------------------------------
// receive-pack (push, protocol v0)
// ---------------------------------------------------------------------------

/** The capabilities a v0 receive-pack advertisement carries on its first line. */
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs';

/** One receive-pack command: the old and new object ids and the ref it targets. */
interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** One command's outcome, reported as an `ok` or `ng` line in the report-status. */
interface CommandResult {
  ref: string;
  ok: boolean;
  reason: string;
}

/** Builds the ordered ref list (HEAD, branches, tags) for a receive-pack advertisement. */
function listAdvertRefs(repo: Repo, shared: SharedState): AdvertisedRef[] {
  const refs: AdvertisedRef[] = [];
  if (repo.branches.size > 0) {
    const defaultOid =
      repo.branches.get(repo.default_branch) ?? [...repo.branches.values()][0];
    refs.push({ oid: defaultOid, refname: 'HEAD' });
    const branches = [...repo.branches.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [branch, oid] of branches) {
      refs.push({ oid, refname: `refs/heads/${branch}` });
    }
  }
  const repoRefs = shared.refs.get(`${repo.owner}/${repo.name}`);
  if (repoRefs) {
    const tags = [...repoRefs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [tagName, tag] of tags) {
      const full = tagName.startsWith('refs/tags/') ? tagName : `refs/tags/${tagName}`;
      refs.push({ oid: tag.oid, refname: full });
      if (tag.peeled) refs.push({ oid: tag.peeled, refname: `${full}^{}` });
    }
  }
  return refs;
}

function createReceivePackAdvert(store: RepoStore, viewer: string, shared: SharedState) {
  void viewer;

  /**
   * Answers the info/refs advertisement for `git-receive-pack` at protocol
   * version zero: a `# service` preamble, one packet line per ref (the first
   * carrying the push capabilities after a NUL byte), the HEAD symbolic
   * reference, and a flush. Returns null when the repository does not exist.
   */
  function advertise(owner: string, name: string): Buffer | null {
    const repo = store.getRepo(owner, name);
    if (!repo) return null;
    const refs = listAdvertRefs(repo, shared);
    const packet = createPacketCodec();
    const out: Buffer[] = [packet.encode('# service=git-receive-pack\n')];
    if (refs.length === 0) {
      out.push(packet.encode(`${ZERO_OID} capabilities^{}\0agent=${AGENT_NAME} ${RECEIVE_CAPS}`));
      out.push(packet.flush());
      return Buffer.concat(out);
    }
    const caps = [
      `agent=${AGENT_NAME}`,
      `symref=HEAD:refs/heads/${repo.default_branch}`,
      RECEIVE_CAPS,
    ].join(' ');
    const first = refs[0];
    out.push(packet.encode(`${first.oid} ${first.refname}\0${caps}`));
    for (const ref of refs.slice(1)) out.push(packet.encode(`${ref.oid} ${ref.refname}`));
    out.push(packet.flush());
    return Buffer.concat(out);
  }

  return advertise;
}

/**
 * Decodes a receive-pack request body: the pkt-lined command list (each line
 * `old new ref`, the first carrying capabilities after a NUL byte) up to the
 * flush packet, then the trailing packfile bytes (possibly empty).
 */
function parsePushCommands(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const packet = createPacketCodec();
  const commands: PushCommand[] = [];
  let offset = 0;
  let sawFlush = false;
  while (offset < body.length) {
    const decoded = packet.decode(body, offset);
    offset += decoded.consumed;
    if (decoded.packet.type === 'flush') {
      sawFlush = true;
      break;
    }
    if (decoded.packet.type !== 'data') continue;
    let line = decoded.packet.data.toString('utf8').replace(/[\r\n]+$/, '');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
  }
  if (!sawFlush) throw new Error('push request has no flush packet');
  return { commands, pack: body.subarray(offset) };
}

/**
 * Resolves the commit an annotated tag peels to, following tag objects to their
 * target until a commit (or an object that is not a tag) is reached. Returns
 * null when the chain does not end at a commit in the store.
 */
function peelToCommit(objects: ObjectStore, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const obj = objects.get(current) as StoreObject | undefined;
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const target = parseTagTarget(obj.raw);
    if (!target) return null;
    current = target;
  }
  return null;
}

/**
 * True when `ancestor` is an ancestor of `oid` (or they are the same commit),
 * decided by walking `oid`'s parent chain through the stored commit objects.
 */
function isAncestor(objects: ObjectStore, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const queue = [oid];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = objects.get(current) as StoreObject | undefined;
    if (!obj || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.raw);
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/**
 * Applies one receive-pack command to the repository state: a branch ref
 * updates (creates, deletes, or fast-forward moves) the branch in the
 * repository store; a tag ref records the tag in the shared refs map with the
 * commit it peels to. An update that is not a fast-forward is refused.
 */
function evaluateCommand(
  repo: Repo,
  cmd: PushCommand,
  objects: ObjectStore,
  shared: SharedState,
  unpackError: string | null,
): CommandResult {
  const { oldOid, newOid, ref } = cmd;
  if (unpackError) return { ref, ok: false, reason: 'unpacker error' };
  const has = (oid: string): boolean => objects.get(oid) !== undefined;

  if (ref.startsWith('refs/heads/')) {
    const branch = ref.slice('refs/heads/'.length);
    const current = repo.branches.get(branch) ?? null;
    if (oldOid === ZERO_OID) {
      if (current !== null) return { ref, ok: false, reason: 'already exists' };
      if (!has(newOid)) return { ref, ok: false, reason: 'missing new object' };
      if (objects.get(newOid)?.type !== 'commit') {
        return { ref, ok: false, reason: 'not a commit' };
      }
      repo.branches.set(branch, newOid);
      return { ref, ok: true, reason: '' };
    }
    if (newOid === ZERO_OID) {
      if (current === null) return { ref, ok: false, reason: 'no such ref' };
      if (current !== oldOid) return { ref, ok: false, reason: 'stale info' };
      repo.branches.delete(branch);
      return { ref, ok: true, reason: '' };
    }
    if (current !== oldOid) return { ref, ok: false, reason: 'stale info' };
    if (!has(newOid)) return { ref, ok: false, reason: 'missing new object' };
    if (objects.get(newOid)?.type !== 'commit') {
      return { ref, ok: false, reason: 'not a commit' };
    }
    if (!isAncestor(objects, oldOid, newOid)) {
      return { ref, ok: false, reason: 'non-fast-forward' };
    }
    repo.branches.set(branch, newOid);
    return { ref, ok: true, reason: '' };
  }

  if (ref.startsWith('refs/tags/')) {
    const key = `${repo.owner}/${repo.name}`;
    let tagMap = shared.refs.get(key);
    if (!tagMap) {
      tagMap = new Map();
      shared.refs.set(key, tagMap);
    }
    const current = tagMap.get(ref) ?? null;
    if (oldOid === ZERO_OID) {
      if (current !== null) return { ref, ok: false, reason: 'already exists' };
      if (!has(newOid)) return { ref, ok: false, reason: 'missing new object' };
      tagMap.set(ref, { oid: newOid, peeled: peelToCommit(objects, newOid) ?? '' });
      return { ref, ok: true, reason: '' };
    }
    if (newOid === ZERO_OID) {
      if (current === null) return { ref, ok: false, reason: 'no such ref' };
      if (current.oid !== oldOid) return { ref, ok: false, reason: 'stale info' };
      tagMap.delete(ref);
      return { ref, ok: true, reason: '' };
    }
    if (current === null || current.oid !== oldOid) {
      return { ref, ok: false, reason: 'stale info' };
    }
    if (!has(newOid)) return { ref, ok: false, reason: 'missing new object' };
    tagMap.set(ref, { oid: newOid, peeled: peelToCommit(objects, newOid) ?? '' });
    return { ref, ok: true, reason: '' };
  }

  return { ref, ok: false, reason: 'unexpected ref name' };
}

/**
 * Builds the receive-pack answer: the report-status stream (pkt-lined `unpack`
 * line plus one `ok`/`ng` line per command) sent on side-band channel one with
 * progress text on channel two.
 */
function buildReport(unpackError: string | null, results: CommandResult[]): Buffer {
  const packet = createPacketCodec();
  const stream: Buffer[] = [];
  stream.push(packet.encode(`unpack ${unpackError ? unpackError : 'ok'}\n`));
  for (const result of results) {
    stream.push(
      result.ok
        ? packet.encode(`ok ${result.ref}\n`)
        : packet.encode(`ng ${result.ref} ${result.reason}\n`),
    );
  }
  stream.push(packet.flush());
  const report = Buffer.concat(stream);
  const out: Buffer[] = [];
  const progress = Buffer.from(`Unpacking objects: ${results.length}, done.\n`, 'utf8');
  out.push(...sidebandChunks(packet, 2, progress));
  out.push(...sidebandChunks(packet, 1, report));
  out.push(packet.flush());
  return Buffer.concat(out);
}

/**
 * One branch's file map: a file path to its content and the id of the blob
 * that holds it. The REST handler keeps one of these per branch, keyed by
 * "owner/name:branch", and exposes the whole collection on itself next to the
 * object store. A push that moves a branch tip must refresh that branch's map
 * so the REST and GraphQL views of the branch's files agree with the git
 * objects.
 */
export type BranchFileMap = Map<string, { content: string; oid: string }>;
/** The per-branch file map collection shared with the REST handler. */
export type BranchFilesMap = Map<string, BranchFileMap>;

/**
 * Rebuilds one branch's file map from the tree of the commit the branch tip
 * points at: walks the tree recursively, reads each blob's content from the
 * object store, and stores every file under its full path with the id of the
 * blob that holds it. Returns the fresh map, or null when the tip commit or
 * any part of its tree (a tree, or a blob it names) cannot be read, so the
 * caller can leave the branch's existing map unchanged.
 */
function rebuildBranchFileMap(objects: ObjectStore, tipOid: string): BranchFileMap | null {
  const commit = objects.get(tipOid);
  if (!commit || commit.type !== 'commit') return null;
  const treeOid = parseCommit(commit.raw).tree;
  const out: BranchFileMap = new Map();
  const walk = (treeId: string, prefix: string): boolean => {
    const treeObj = objects.get(treeId);
    if (!treeObj || treeObj.type !== 'tree') return false;
    let entries: TreeEntry[];
    try {
      entries = parseTreeEntries(treeObj.raw);
    } catch {
      return false;
    }
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isSubtree(entry.mode)) {
        if (!walk(entry.oid, path)) return false;
      } else if (entry.mode === '100644' || entry.mode === '100755') {
        const blob = objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return false;
        const raw = blob.raw;
        const nul = raw.indexOf(0);
        const content = (nul === -1 ? raw : raw.subarray(nul + 1)).toString('utf8');
        out.set(path, { content, oid: entry.oid });
      }
    }
    return true;
  };
  if (!walk(treeOid, '')) return null;
  return out;
}

/**
 * Refreshes one branch's file map after a push moved the branch tip to
 * `newOid`: rebuilds the map from the pushed commit's tree so the REST and
 * GraphQL views of the branch's files agree with the git objects. Any failure
 * leaves the branch's existing map untouched — a push must never fail because
 * of this refresh, so errors are swallowed here.
 */
function refreshBranchFileMap(
  getFileMap: () => BranchFilesMap,
  repo: Repo,
  branch: string,
  objects: ObjectStore,
  newOid: string,
): void {
  try {
    const rebuilt = rebuildBranchFileMap(objects, newOid);
    if (rebuilt === null) return;
    const maps = getFileMap();
    maps.set(`${repo.owner}/${repo.name}:${branch}`, rebuilt);
  } catch {
    // Leave the existing map unchanged; never fail the push.
  }
}

function createReceivePack(
  store: RepoStore,
  getObjects: () => ObjectStore,
  getFileMap: () => BranchFilesMap,
  viewer: string,
  shared: SharedState,
) {
  void viewer;

  /**
   * Handles a git-receive-pack request: parses the command list and the
   * packfile, stores every object from the packfile in the object store,
   * updates each branch or tag ref (refusing per-ref any update that is not a
   * fast-forward), and answers with the per-ref report. Returns null when the
   * repository does not exist.
   */
  function receive(owner: string, name: string, body: Buffer): Buffer | null {
    const repo = store.getRepo(owner, name);
    if (!repo) return null;
    const objects = getObjects();

    let commands: PushCommand[];
    let pack: Buffer;
    try {
      ({ commands, pack } = parsePushCommands(body));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildReport(message, []);
    }

    let unpackError: string | null = null;
    if (pack.length > 0) {
      try {
        const read = createPackfileCodec(objects).read(pack);
        for (const obj of read) {
          objects.put(obj.oid, obj as StoredObject);
        }
      } catch (err) {
        unpackError = err instanceof Error ? err.message : String(err);
      }
    }

    const results: CommandResult[] = [];
    for (const cmd of commands) {
      const result = evaluateCommand(repo, cmd, objects, shared, unpackError);
      results.push(result);
      // A push moved a branch tip, but the REST/GraphQL view of the branch's
      // files is the per-branch file map the REST handler keeps — copying it
      // from a source branch is only what that handler does when a branch is
      // created through the ref endpoint. Rebuild the map from the pushed
      // commit's tree so the views agree.
      if (result.ok && cmd.ref.startsWith('refs/heads/') && cmd.newOid !== ZERO_OID) {
        refreshBranchFileMap(
          getFileMap,
          repo,
          cmd.ref.slice('refs/heads/'.length),
          objects,
          cmd.newOid,
        );
      }
    }
    return buildReport(unpackError, results);
  }

  return receive;
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

/** One git request the server dispatches to the handler. */
export interface GitRequest {
  method: string;
  headers: Record<string, string>;
  body: Buffer;
  segments: string[];
  /** URL query parameters (e.g. `service=git-receive-pack` on info/refs). */
  query?: Record<string, string>;
}

/** The handler's answer: a status, headers, and a body that may be binary. */
export interface GitResponse {
  status: number;
  headers: Record<string, string | number>;
  body: Buffer | string;
}

function jsonError(status: number, message: string): GitResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify({ message })),
  };
}

function createGitHandler(
  store: RepoStore,
  getObjects: () => ObjectStore,
  getFileMap: () => BranchFilesMap,
  viewer: string,
  shared: SharedState,
) {
  const advertise = createRefAdvert(store, viewer, shared);
  const answerLsRefs = createLsRefs(store, viewer, shared);
  const answerFetch = createFetch(store, getObjects, viewer, shared);
  const receiveAdvert = createReceivePackAdvert(store, viewer, shared);
  const answerReceive = createReceivePack(store, getObjects, getFileMap, viewer, shared);

  /**
   * Handles one git smart HTTP request. GET info/refs is answered with the
   * upload-pack ref advertisement (protocol version taken from the Git-Protocol
   * header); POST git-upload-pack is answered with a protocol-v2 ls-refs answer,
   * a protocol-v2 fetch answer, or a protocol-v0 fetch answer (honouring want,
   * have, shallow and deepen, answered with a side-band packfile). A missing or
   * wrong Bearer token is 401, and an unknown repository is 404.
   */
  async function handle(request: GitRequest): Promise<GitResponse> {
    const expected = `Bearer ${process.env.MAKEFUN_SHOP_TOKEN ?? ''}`;
    if ((request.headers['authorization'] ?? '') !== expected) {
      return jsonError(401, 'Unauthorized');
    }
    const owner = request.segments[0] ?? '';
    const namePart = request.segments[1] ?? '';
    const name = namePart.endsWith('.git') ? namePart.slice(0, -4) : namePart;
    const sub = request.segments.slice(2).join('/');
    const method = request.method.toUpperCase();

    if (method === 'GET' && sub === 'info/refs') {
      const service = request.query?.['service'] ?? 'git-upload-pack';
      if (service === 'git-receive-pack') {
        const result = receiveAdvert(owner, name);
        if (result === null) return jsonError(404, 'Not Found');
        return {
          status: 200,
          headers: {
            'Content-Type': 'application/x-git-receive-pack-advertisement',
            'Content-Length': String(result.length),
          },
          body: result,
        };
      }
      const version = /version=2/.test(request.headers['git-protocol'] ?? '') ? 2 : 0;
      const result = advertise(owner, name, version);
      if (result === null) return jsonError(404, 'Not Found');
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/x-git-upload-pack-advertisement',
          'Content-Length': String(result.length),
        },
        body: result,
      };
    }

    if (method === 'POST' && sub === 'git-upload-pack') {
      // Protocol-v2 ls-refs (the tested ref-listing path, unchanged in behaviour).
      let lsArgs: LsRefsRequest | null = null;
      try {
        lsArgs = parseLsRefsRequest(request.body);
      } catch {
        lsArgs = null;
      }
      if (lsArgs && lsArgs.command === 'ls-refs') {
        const result = answerLsRefs(owner, name, lsArgs);
        if (result === null) return jsonError(404, 'Not Found');
        return {
          status: 200,
          headers: {
            'Content-Type': 'application/x-git-upload-pack-result',
            'Content-Length': String(result.length),
          },
          body: result,
        };
      }

      // upload-pack fetch: protocol v2 (command=fetch) or protocol v0 (want lines).
      let fetchArgs: FetchRequest;
      try {
        fetchArgs = parseFetchRequest(request.body);
      } catch {
        return jsonError(400, 'Bad Request');
      }
      if (fetchArgs.command !== 'fetch' && fetchArgs.command !== '') {
        return jsonError(501, 'Not Implemented');
      }
      const version: 0 | 2 = fetchArgs.command === 'fetch' ? 2 : 0;
      const result = answerFetch(owner, name, fetchArgs, version);
      if (result === null) return jsonError(404, 'Not Found');
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/x-git-upload-pack-result',
          'Content-Length': String(result.length),
        },
        body: result,
      };
    }

    if (method === 'POST' && sub === 'git-receive-pack') {
      const result = answerReceive(owner, name, request.body);
      if (result === null) return jsonError(404, 'Not Found');
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/x-git-receive-pack-result',
          'Content-Length': String(result.length),
        },
        body: result,
      };
    }

    return jsonError(404, 'Not Found');
  }

  return handle;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** The surface this module exposes. */
export interface GitModule {
  packet: PacketCodec;
  packfile: PackfileCodec;
  /** upload-pack ref advertisement for info/refs, or null for an unknown repo. */
  refAdvert: (owner: string, name: string, version: number) => Buffer | null;
  /** protocol-v2 ls-refs answer, or null for an unknown repo. */
  lsRefs: (owner: string, name: string, request: LsRefsRequest) => Buffer | null;
  /** upload-pack fetch answer (protocol v0 or v2), or null for an unknown repo. */
  fetch: (
    owner: string,
    name: string,
    request: FetchRequest,
    version: 0 | 2,
  ) => Buffer | null;
  /** receive-pack v0 ref advertisement for info/refs, or null for an unknown repo. */
  receiveAdvert: (owner: string, name: string) => Buffer | null;
  /** receive-pack push answer (store objects, update refs, report), or null for an unknown repo. */
  receive: (owner: string, name: string, body: Buffer) => Buffer | null;
  /** git smart HTTP dispatcher for info/refs and git-upload-pack. */
  handle: (request: GitRequest) => Promise<GitResponse>;
}

/**
 * Builds the git wire-format module against a repository store, the real object
 * store (via `getObjects`, a lazy accessor: the REST handler attaches the object
 * store only after its first request), the per-branch file map collection the
 * REST handler exposes (via `getFileMap`, the same lazy pattern, refreshed
 * after a push moves a branch tip), the viewer login, and the shared state
 * that holds pushed tags. The packet-line codec is stateless; the packfile
 * writer/reader and the fetch reachability walk use the object store (not the
 * repository store, which has no per-object lookup); the ref advertisement reads
 * branches and pushed tags, the ls-refs answer serves protocol-v2 ref listing,
 * the fetch answer serves protocol-v0/v2 upload-pack fetch (want/have/shallow/
 * deepen, side-band pack), and the handle function dispatches the smart HTTP
 * info/refs and git-upload-pack endpoints.
 */
export function createGitModule(
  store: RepoStore,
  getObjects: () => ObjectStore,
  getFileMap: () => BranchFilesMap,
  viewer: string,
  shared: SharedState,
): GitModule {
  return {
    packet: createPacketCodec(),
    packfile: createPackfileCodec(getObjects()),
    refAdvert: createRefAdvert(store, viewer, shared),
    lsRefs: createLsRefs(store, viewer, shared),
    fetch: createFetch(store, getObjects, viewer, shared),
    receiveAdvert: createReceivePackAdvert(store, viewer, shared),
    receive: createReceivePack(store, getObjects, getFileMap, viewer, shared),
    handle: createGitHandler(store, getObjects, getFileMap, viewer, shared),
  };
}
