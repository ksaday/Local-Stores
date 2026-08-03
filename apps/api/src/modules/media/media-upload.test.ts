import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { MediaQueue } from "../../infra/queue/queue.module.js";
import { LocalDiskStorage } from "../../infra/storage/storage.provider.js";
import { testStorage } from "../../infra/storage/test-storage.js";
import { AuditService } from "../audit/audit.service.js";
import { MediaService } from "./media.service.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const STORE = "f7000000-0000-4000-8000-00000000000a";
const OWNER = "f7000000-0000-4000-8000-000000000001";

const config = {
  get: (key: string) =>
    key === "REDIS_URL" ? (process.env.REDIS_URL ?? "redis://localhost:6379") : "test",
} as never;

let prisma: PrismaService;
let storage: LocalDiskStorage;
let media: MediaService;
let queue: MediaQueue;
let storageRoot: string;

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "bba-upload-"));
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  await seed();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  storage = new LocalDiskStorage(testStorage(storageRoot));
  queue = new MediaQueue(config, `test-upload-${randomUUID().slice(0, 8)}`);
  media = new MediaService(prisma, storage, new AuditService(prisma), queue);
  await asAdmin((a) => a.$executeRaw`DELETE FROM media_assets WHERE store_id = ${STORE}`);
});

afterEach(async () => {
  await queue.obliterate();
  await queue.onModuleDestroy();
});

async function asAdmin<T>(work: (admin: PrismaService) => Promise<T>): Promise<T> {
  const admin = new PrismaService();
  try {
    return await work(admin);
  } finally {
    await admin.$disconnect();
  }
}

async function seed(): Promise<void> {
  await cleanup();
  await asAdmin(async (admin) => {
    await admin.$executeRaw`
      INSERT INTO users (id, email, name, status, created_at, updated_at)
      VALUES (${OWNER}, 'upload-owner@example.com'::citext, 'Owner', 'ACTIVE', now(), now())`;
    await admin.$executeRaw`
      INSERT INTO stores (id, slug, name, business_type, status, owner_user_id, timezone,
                          currency, branding, cash_enabled, stripe_charges_enabled,
                          platform_fee_bps, created_at, updated_at)
      VALUES (${STORE}, 'upload-store'::citext, 'Upload Store', 'RETAIL', 'ACTIVE', ${OWNER},
              'America/Chicago', 'USD', '{}'::jsonb, true, false, 0, now(), now())`;
  });
}

async function cleanup(): Promise<void> {
  await asAdmin(async (admin) => {
    await admin.$executeRaw`DELETE FROM media_assets WHERE store_id = ${STORE}`;
    await admin.$executeRaw`DELETE FROM stores WHERE id = ${STORE}`;
    await admin.$executeRaw`DELETE FROM users WHERE id = ${OWNER}`;
  });
}

const scope = { storeId: STORE, userId: OWNER, isSuperAdmin: false };

function png(): Promise<Buffer> {
  return sharp({ create: { width: 60, height: 40, channels: 3, background: "#123456" } })
    .png()
    .toBuffer();
}

async function request(overrides: Partial<Parameters<MediaService["requestUpload"]>[0]> = {}) {
  return media.requestUpload({
    declaredMime: "image/png",
    declaredBytes: 1024,
    kind: "PRODUCT",
    storeId: STORE,
    ownerUserId: OWNER,
    ...overrides,
  });
}

/** The key inside the signed grant, which is where the client must PUT. */
function keyFromUpload(url: string): string {
  const token = url.split("/").pop()!;
  return storage.verifyGrant(token).key;
}

describe("the upload grant", () => {
  it("hands back a signed, time-limited grant for one key", async () => {
    const { assetId, upload } = await request();

    expect(assetId).toBeTruthy();
    expect(upload.method).toBe("PUT");
    expect(upload.headers["Content-Type"]).toBe("image/png");
    expect(upload.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const grant = storage.verifyGrant(upload.url.split("/").pop()!);
    // The key is server-generated and names exactly one object.
    expect(grant.key).toMatch(/^product\/[0-9a-f-]{36}\.bin$/);
    expect(grant.mime).toBe("image/png");
  });

  it("refuses a token whose payload has been edited", async () => {
    const { upload } = await request();
    const [payload, signature] = upload.url.split("/").pop()!.split(".");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString());

    // Point the grant at somebody else's object and keep the old signature.
    decoded.key = "product/somebody-elses-asset.bin";
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;

    expect(() => storage.verifyGrant(forged)).toThrow();
  });

  it("refuses a grant that has expired", async () => {
    // A short-lived grant rather than a mocked clock: these suites share one
    // process, and moving the system time under them makes something else fail
    // somewhere unrelated.
    const brief = new LocalDiskStorage({ ...testStorage(storageRoot), uploadTtlMs: 1 });
    const upload = await brief.presignUpload("product/x.bin", "image/png", 1024);
    const token = upload.url.split("/").pop()!;

    await new Promise((resolve) => setTimeout(resolve, 10));

    // A link left open in a tab is not a standing permission to write.
    expect(() => brief.verifyGrant(token)).toThrow();
  });

  it("refuses a type it would never re-encode, before any bytes exist", async () => {
    // SVG is XML that browsers execute. Rejected at step one so no grant is
    // ever issued for one.
    await expect(request({ declaredMime: "image/svg+xml" })).rejects.toThrow();
    await expect(request({ declaredBytes: 11 * 1024 * 1024 })).rejects.toThrow();
    await expect(request({ declaredBytes: 0 })).rejects.toThrow();
  });
});

describe("completing an upload", () => {
  it("queues the image once the bytes are there", async () => {
    const { assetId, upload } = await request();
    await storage.putQuarantine(keyFromUpload(upload.url), await png());

    const result = await media.completeUpload(assetId, scope);

    expect(result.status).toBe("PENDING");
    const [job] = await queue.waiting();
    expect(job!.data.assetId).toBe(assetId);
  });

  it("says so when the client never uploaded anything", async () => {
    const { assetId } = await request();

    // Without this the job would be queued, fail three times against a missing
    // file, and dead-letter — a confusing way to report "you skipped a step".
    await expect(media.completeUpload(assetId, scope)).rejects.toMatchObject({ status: 400 });
    expect(await queue.waiting()).toHaveLength(0);
  });

  it("does not queue the same image twice when completed twice", async () => {
    const { assetId, upload } = await request();
    await storage.putQuarantine(keyFromUpload(upload.url), await png());

    await media.completeUpload(assetId, scope);
    await media.completeUpload(assetId, scope);

    // A double-tapped "done" costs one job, not two runs of sharp over the
    // same file.
    expect(await queue.waiting()).toHaveLength(1);
  });

  it("is not completable from another store", async () => {
    const { assetId, upload } = await request();
    await storage.putQuarantine(keyFromUpload(upload.url), await png());

    // RLS decides this, not the service: the row simply is not visible.
    await expect(
      media.completeUpload(assetId, {
        storeId: "f7000000-0000-4000-8000-00000000000b",
        isSuperAdmin: false,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
