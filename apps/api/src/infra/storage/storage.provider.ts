import { Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";

/** A one-shot permission to write exactly one object, and nothing else. */
export interface PresignedUpload {
  url: string;
  method: "PUT";
  /** Headers the client must send. The signature covers them. */
  headers: Record<string, string>;
  maxBytes: number;
  expiresAt: Date;
}

/**
 * Object storage (plan §12.10). S3 + CloudFront in production; local disk in
 * development so the upload pipeline is exercisable without cloud credentials.
 *
 * Keys are always server-generated. No method accepts a caller-supplied path
 * fragment — that is the path-traversal defense, enforced by the shape of the
 * interface rather than by remembering to sanitise at each call site.
 */
export abstract class StorageProvider {
  /**
   * A URL the client PUTs the file to directly.
   *
   * The point of the indirection is that untrusted bytes never pass through
   * the API process (plan §13.7). The declared type and a size ceiling are
   * bound into the grant, so the storage layer refuses anything else without
   * this application ever seeing it.
   */
  abstract presignUpload(key: string, mime: string, maxBytes: number): Promise<PresignedUpload>;

  /** Bytes not yet validated. Never publicly served. */
  abstract putQuarantine(key: string, body: Buffer): Promise<void>;
  abstract readQuarantine(key: string): Promise<Buffer>;
  abstract discardQuarantine(key: string): Promise<void>;

  /** Size of a quarantined object, or null if the client never uploaded it. */
  abstract quarantineSize(key: string): Promise<number | null>;

  /** Validated, re-encoded bytes. `isPrivate` assets are never CDN-served. */
  abstract putProcessed(key: string, body: Buffer, isPrivate: boolean): Promise<void>;

  abstract publicUrl(key: string): string;

  /**
   * A URL that reads one private object, and stops working shortly after.
   *
   * Delivery proofs are photographs of somebody's doorway and their
   * handwriting, so they are never CDN-served and never guessable (§13.5).
   * They are also read by an `<img>` tag, which sends no Authorization header
   * and cannot be made to — hence a URL carrying its own authority rather than
   * a route behind the guards.
   *
   * Short-lived because the URL will end up in a server-rendered page, a
   * screenshot, a shared link. Long enough to look at the photograph; not long
   * enough to be a distribution channel.
   */
  abstract presignRead(key: string, ttlMs?: number): Promise<string>;

  /** Reads a processed private object. Only ever through `presignRead`. */
  abstract readPrivate(key: string): Promise<Buffer>;

  /**
   * URL of one processed variant of an asset.
   *
   * `storageKey` names a folder, not a file: the worker writes `thumb.webp`,
   * `medium.webp`, `large.webp` and `original.webp` underneath it. Passing the
   * key straight to `publicUrl` yields a directory and a broken image, which is
   * exactly the bug this method exists to stop anyone writing twice.
   */
  publicVariantUrl(storageKey: string, variant: MediaVariant = "original"): string {
    return this.publicUrl(`${storageKey}/${variant}.webp`);
  }
}

/** The sizes the worker writes for every accepted image. */
export type MediaVariant = "thumb" | "medium" | "large" | "original";

export interface LocalDiskOptions {
  root: string;
  /** Where processed public objects are read from. */
  publicBaseUrl: string;
  /** Where the local stand-in for a presigned PUT is served. */
  uploadBaseUrl: string;
  /** Where the local stand-in for a presigned GET is served. */
  readBaseUrl: string;
  /** Signs upload grants. See `presignUpload`. */
  uploadSecret: string;
  /** How long a grant is good for. Defaults to 15 minutes. */
  uploadTtlMs?: number;
}

/** What a signed local upload token permits. */
export interface UploadGrant {
  key: string;
  mime: string;
  maxBytes: number;
  /** Epoch milliseconds. */
  exp: number;
}

/** What a signed local read token permits. */
export interface ReadGrant {
  key: string;
  /** Epoch milliseconds. */
  exp: number;
}

/** Default life of an upload grant. S3's presigned URLs are commonly similar. */
const DEFAULT_UPLOAD_TTL_MS = 15 * 60 * 1000;

/**
 * Default life of a read grant.
 *
 * Shorter than an upload's, and for a different reason: an upload grant is
 * held by the one client doing the upload, while a read URL is rendered into a
 * page and travels — into a browser history, a screenshot, a pasted link. Ten
 * minutes is long enough to open the photograph and look at it.
 */
const DEFAULT_READ_TTL_MS = 10 * 60 * 1000;

const QUARANTINE = "quarantine";
const PUBLIC = "public";
const PRIVATE = "private";

@Injectable()
export class LocalDiskStorage extends StorageProvider {
  private readonly root: string;
  private readonly baseUrl: string;
  private readonly uploadBaseUrl: string;
  private readonly readBaseUrl: string;
  private readonly uploadSecret: string;
  /**
   * A separate key for read grants, derived from the upload one.
   *
   * Both grants are HMACs over a JSON payload, so a single key would let an
   * upload token be presented as a read token and the other way round —
   * the signature checks out, and only the field names differ. Separate keys
   * make that a verification failure rather than something the parsing has to
   * be careful about.
   */
  private readonly readSecret: string;
  private readonly uploadTtlMs: number;

  constructor(options: LocalDiskOptions) {
    super();
    this.root = options.root;
    this.baseUrl = options.publicBaseUrl;
    this.uploadBaseUrl = options.uploadBaseUrl;
    this.readBaseUrl = options.readBaseUrl;
    this.uploadSecret = options.uploadSecret;
    this.readSecret = createHmac("sha256", options.uploadSecret).update("read").digest("hex");
    this.uploadTtlMs = options.uploadTtlMs ?? DEFAULT_UPLOAD_TTL_MS;
  }

  /**
   * The local stand-in for a presigned S3 PUT.
   *
   * With nothing but a disk there is no second service to upload to, so in
   * development the bytes do reach the API process — the property §13.7 buys
   * in production cannot be had here. The grant is still a real one: the key,
   * the declared type and the size ceiling are signed, so the route that
   * accepts the PUT takes none of them from the caller. That keeps this a
   * faithful rehearsal of the S3 path rather than an open upload endpoint.
   *
   * Same trade as `LogMailer`: the alternative is not being able to exercise
   * the flow at all locally.
   */
  async presignUpload(key: string, mime: string, maxBytes: number): Promise<PresignedUpload> {
    const expiresAt = new Date(Date.now() + this.uploadTtlMs);
    const grant: UploadGrant = { key, mime, maxBytes, exp: expiresAt.getTime() };
    const token = this.sign(grant, this.uploadSecret);

    return {
      url: `${this.uploadBaseUrl.replace(/\/$/, "")}/${token}`,
      method: "PUT",
      headers: { "Content-Type": mime },
      maxBytes,
      expiresAt,
    };
  }

  /**
   * Checks a grant and returns what it permits.
   *
   * Throws rather than returning null: every failure here is either an expired
   * grant or a forged one, and neither should be distinguishable to the caller.
   */
  verifyGrant(token: string): UploadGrant {
    return this.verify<UploadGrant>(token, this.uploadSecret);
  }

  /**
   * The local stand-in for a presigned S3 GET.
   *
   * The signed key is the whole authority — the route serving it has no
   * session, exactly as CloudFront has none. Whoever hands out the URL has
   * already decided the reader is entitled to it.
   */
  async presignRead(key: string, ttlMs: number = DEFAULT_READ_TTL_MS): Promise<string> {
    const grant: ReadGrant = { key, exp: Date.now() + ttlMs };
    return `${this.readBaseUrl.replace(/\/$/, "")}/${this.sign(grant, this.readSecret)}`;
  }

  /** Checks a read grant. Throws for forged, malformed and expired alike. */
  verifyReadGrant(token: string): ReadGrant {
    return this.verify<ReadGrant>(token, this.readSecret);
  }

  private sign(grant: UploadGrant | ReadGrant, secret: string): string {
    const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
    const signature = createHmac("sha256", secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  private verify<T extends { exp: number }>(token: string, secret: string): T {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) throw new Error("Malformed token.");

    const expected = createHmac("sha256", secret).update(payload).digest("base64url");
    // Constant-time: a length-varying compare leaks the signature a byte at a
    // time to anyone willing to make enough requests.
    const given = Buffer.from(signature);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new Error("Invalid token.");
    }

    const grant = JSON.parse(Buffer.from(payload, "base64url").toString()) as T;
    if (Date.now() > grant.exp) throw new Error("This link has expired.");
    return grant;
  }

  async putQuarantine(key: string, body: Buffer): Promise<void> {
    await this.write(join(QUARANTINE, key), body);
  }

  async quarantineSize(key: string): Promise<number | null> {
    return stat(this.safePath(join(QUARANTINE, key))).then(
      (s) => s.size,
      () => null,
    );
  }

  async readQuarantine(key: string): Promise<Buffer> {
    return readFile(this.safePath(join(QUARANTINE, key)));
  }

  async discardQuarantine(key: string): Promise<void> {
    await rm(this.safePath(join(QUARANTINE, key)), { force: true });
  }

  async putProcessed(key: string, body: Buffer, isPrivate: boolean): Promise<void> {
    await this.write(join(isPrivate ? PRIVATE : PUBLIC, key), body);
  }

  async readPrivate(key: string): Promise<Buffer> {
    return readFile(this.safePath(join(PRIVATE, key)));
  }

  publicUrl(key: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}/${PUBLIC}/${key}`;
  }

  private async write(relative: string, body: Buffer): Promise<void> {
    const path = this.safePath(relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  /**
   * Belt-and-braces containment. Keys are server-generated so this should never
   * fire, but the gap between a bug here and an arbitrary-file-write is small
   * enough that it is checked rather than assumed.
   */
  private safePath(relative: string): string {
    const root = resolve(this.root);
    const path = resolve(join(root, normalize(relative)));
    if (path !== root && !path.startsWith(root + sep)) {
      throw new Error(`Refusing to write outside the storage root: ${relative}`);
    }
    return path;
  }
}
