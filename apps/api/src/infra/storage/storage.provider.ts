import { Injectable } from "@nestjs/common";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";

/**
 * Object storage (plan §12.10). S3 + CloudFront in production; local disk in
 * development so the upload pipeline is exercisable without cloud credentials.
 *
 * Keys are always server-generated. No method accepts a caller-supplied path
 * fragment — that is the path-traversal defense, enforced by the shape of the
 * interface rather than by remembering to sanitise at each call site.
 */
export abstract class StorageProvider {
  /** Bytes not yet validated. Never publicly served. */
  abstract putQuarantine(key: string, body: Buffer): Promise<void>;
  abstract readQuarantine(key: string): Promise<Buffer>;
  abstract discardQuarantine(key: string): Promise<void>;

  /** Validated, re-encoded bytes. `isPrivate` assets are never CDN-served. */
  abstract putProcessed(key: string, body: Buffer, isPrivate: boolean): Promise<void>;

  abstract publicUrl(key: string): string;
}

const QUARANTINE = "quarantine";
const PUBLIC = "public";
const PRIVATE = "private";

@Injectable()
export class LocalDiskStorage extends StorageProvider {
  constructor(
    private readonly root: string,
    private readonly baseUrl: string,
  ) {
    super();
  }

  async putQuarantine(key: string, body: Buffer): Promise<void> {
    await this.write(join(QUARANTINE, key), body);
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
