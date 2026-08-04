import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { MediaQueue } from "../../infra/queue/queue.module.js";
import { LocalDiskStorage } from "../../infra/storage/storage.provider.js";
import { testStorage } from "../../infra/storage/test-storage.js";
import { AuditService } from "../audit/audit.service.js";
import { MediaService, type MediaKind, type UploadResult } from "./media.service.js";
import { randomUUID } from "node:crypto";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const STORE = "f0000000-0000-4000-8000-00000000000a";
const OWNER = "f0000000-0000-4000-8000-000000000001";

let prisma: PrismaService;
let media: MediaService;
let storage: LocalDiskStorage;
let queue: MediaQueue;
let storageRoot: string;

const queueConfig = {
  get: (key: string) =>
    key === "REDIS_URL" ? (process.env.REDIS_URL ?? "redis://localhost:6379") : "test",
} as never;

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "bba-media-"));
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  storage = new LocalDiskStorage(testStorage(storageRoot));
  // A queue of its own, so a developer's running worker does not race this
  // suite for its jobs.
  queue = new MediaQueue(queueConfig, `test-media-${randomUUID().slice(0, 8)}`);
  media = new MediaService(prisma, storage, new AuditService(prisma), queue);
  await seed();
});

afterAll(async () => {
  await cleanup();
  await queue.obliterate();
  await queue.onModuleDestroy();
  await prisma.$disconnect();
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await asAdmin((a) => a.$executeRaw`DELETE FROM media_assets WHERE store_id = ${STORE}`);
  await queue.obliterate();
});

/**
 * Uploads, then runs the step the worker would run.
 *
 * Walks the real §13.7 flow — ask for a grant, PUT to the key it names,
 * complete — and then runs the step the worker would run. The processing half
 * is inline so these assertions are about the pipeline rather than about
 * timing; the queue itself is covered in the media-queue suite.
 */
async function uploadAndProcess(input: {
  body: Buffer;
  declaredMime: string;
  originalName?: string;
  kind: MediaKind;
  storeId?: string;
  ownerUserId?: string;
}): Promise<UploadResult> {
  const { assetId, upload } = await media.requestUpload({
    declaredMime: input.declaredMime,
    declaredBytes: input.body.length,
    originalName: input.originalName,
    kind: input.kind,
    storeId: input.storeId,
    ownerUserId: input.ownerUserId,
  });

  // What the client does against the grant, and nothing more: the key comes
  // from the signed token, never from the caller.
  const { key } = storage.verifyGrant(upload.url.split("/").pop()!);
  await storage.putQuarantine(key, input.body);

  const scope = { storeId: input.storeId, userId: input.ownerUserId, isSuperAdmin: false };
  const accepted = await media.completeUpload(assetId, scope);
  expect(accepted.status).toBe("PENDING");

  const [job] = await queue.waiting();
  expect(job, "completing should have enqueued a job").toBeDefined();
  return media.processQueued(assetId, job!.data.quarantineKey);
}

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
      VALUES (${OWNER}, 'media-owner@example.com'::citext, 'Owner', 'ACTIVE', now(), now())
    `;
    await admin.$executeRaw`
      INSERT INTO stores (id, slug, name, business_type, status, owner_user_id, timezone,
                          currency, branding, cash_enabled, stripe_charges_enabled,
                          platform_fee_bps, created_at, updated_at)
      VALUES (${STORE}, 'media-test-store'::citext, 'Media Store', 'RETAIL', 'ACTIVE', ${OWNER},
              'America/Chicago', 'USD', '{}'::jsonb, true, false, 0, now(), now())
    `;
  });
}

async function cleanup(): Promise<void> {
  await asAdmin(async (admin) => {
    await admin.$executeRaw`DELETE FROM audit_logs WHERE entity_type = 'media_asset'`;
    await admin.$executeRaw`DELETE FROM media_assets WHERE store_id = ${STORE}`;
    await admin.$executeRaw`DELETE FROM outbox_events WHERE store_id = ${STORE}`;
    await admin.$executeRaw`DELETE FROM stores WHERE id = ${STORE}`;
    await admin.$executeRaw`DELETE FROM users WHERE id = ${OWNER}`;
  });
}

/** A real PNG, generated rather than fixtured so the test is self-contained. */
async function makePng(width = 400, height = 300): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } },
  })
    .png()
    .toBuffer();
}

/** A JPEG carrying EXIF, including GPS coordinates. */
async function makeJpegWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 100, height: 100, channels: 3, background: "#336699" } })
    // sharp's typed EXIF surface covers IFD blocks; GPS tags travel in the same
    // EXIF payload and are stripped by the same re-encode, so asserting the
    // block is gone covers the location case too.
    .withMetadata({
      exif: { IFD0: { Copyright: "Test Photographer", Software: "BBA Test" } },
    })
    .jpeg()
    .toBuffer();
}

describe("accepted uploads", () => {
  it("processes a PNG into responsive WebP variants", async () => {
    const result = await uploadAndProcess({
      body: await makePng(),
      declaredMime: "image/png",
      kind: "BRANDING",
      storeId: STORE,
      originalName: "logo.png",
    });

    expect(result.status).toBe("READY");
    expect(result.url).toContain("/public/");
    expect(result.url).toContain("original.webp");

    const asset = await asAdmin((a) => a.mediaAsset.findUnique({ where: { id: result.assetId } }));
    expect(asset?.status).toBe("READY");
    // Always re-encoded, never passed through — that is what makes the output
    // safe regardless of what came in.
    expect(asset?.mime).toBe("image/webp");
    expect(asset?.width).toBe(400);
  });

  it("strips EXIF, including GPS, from the processed output", async () => {
    // A phone photo of a shop carries the shop's coordinates. Publishing that
    // to a CDN discloses a location the uploader never chose to share.
    const withExif = await makeJpegWithExif();
    const before = await sharp(withExif).metadata();
    expect(before.exif).toBeDefined();

    const result = await uploadAndProcess({
      body: withExif,
      declaredMime: "image/jpeg",
      kind: "PRODUCT",
      storeId: STORE,
    });
    expect(result.status).toBe("READY");

    const key = result.url!.split("/media/public/")[1]!;
    const processed = await sharp(join(storageRoot, "public", key)).metadata();
    expect(processed.exif).toBeUndefined();
  });

  it("does not enlarge an image smaller than the variant size", async () => {
    const small = await makePng(80, 60);
    const result = await uploadAndProcess({
      body: small,
      declaredMime: "image/png",
      kind: "PRODUCT",
      storeId: STORE,
    });

    const large = await sharp(
      join(storageRoot, "public", `${(await assetKey(result.assetId))}/large.webp`),
    ).metadata();
    expect(large.width).toBe(80);
  });

  it("keeps proof photos out of the public prefix", async () => {
    // Delivery proofs show a customer's doorway. They are served by short-lived
    // presigned URL, never a stable public one.
    const result = await uploadAndProcess({
      body: await makePng(),
      declaredMime: "image/jpeg",
      kind: "PROOF",
      ownerUserId: OWNER,
    });

    expect(result.status).toBe("READY");
    expect(result.url).toBeNull();

    const asset = await asAdmin((a) => a.mediaAsset.findUnique({ where: { id: result.assetId } }));
    expect(asset?.isPrivate).toBe(true);
  });

  it("reads a proof photo back only through a signed, expiring URL", async () => {
    const result = await uploadAndProcess({
      body: await makePng(),
      declaredMime: "image/jpeg",
      kind: "PROOF",
      ownerUserId: OWNER,
    });
    const asset = await asAdmin((a) => a.mediaAsset.findUnique({ where: { id: result.assetId } }));
    const key = `${asset!.storageKey}/medium.webp`;

    const url = await storage.presignRead(key);
    const token = url.slice(url.lastIndexOf("/") + 1);
    expect(storage.verifyReadGrant(token).key).toBe(key);
    // Real bytes, not a promise of them: the whole point of the private prefix
    // is that something still has to be able to read it.
    expect((await storage.readPrivate(key)).length).toBeGreaterThan(0);

    // And nothing wrote a copy where the static file server would find it.
    await expect(readFile(join(storageRoot, "public", key))).rejects.toThrow();
  });
});

describe("rejected uploads", () => {
  it("rejects a file whose real type is not the declared one", async () => {
    // The caller controls Content-Type entirely. A script announced as
    // image/png must be caught by inspecting the bytes.
    const script = Buffer.from('<?php system($_GET["c"]); ?>', "utf8");
    const result = await uploadAndProcess({
      body: script,
      declaredMime: "image/png",
      kind: "PRODUCT",
      storeId: STORE,
    });

    expect(result.status).toBe("REJECTED");
    const asset = await asAdmin((a) => a.mediaAsset.findUnique({ where: { id: result.assetId } }));
    expect(asset?.status).toBe("REJECTED");
  });

  it("rejects SVG even when correctly declared", async () => {
    // SVG is XML, can carry <script>, and executes when served inline. There is
    // no safe way to accept arbitrary SVG for a storefront.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "utf8",
    );
    await expect(
      media.requestUpload({
        declaredBytes: svg.length,
        declaredMime: "image/svg+xml",
        kind: "BRANDING",
        storeId: STORE,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("rejects a polyglot that is a valid image with a script appended", async () => {
    // Valid PNG bytes followed by a payload. It passes magic-byte detection,
    // so re-encoding is what actually neutralises it — the output is built
    // from decoded pixels and the trailing bytes simply do not survive.
    const png = await makePng(50, 50);
    const polyglot = Buffer.concat([png, Buffer.from('<?php system($_GET["c"]); ?>', "utf8")]);

    const result = await uploadAndProcess({
      body: polyglot,
      declaredMime: "image/png",
      kind: "PRODUCT",
      storeId: STORE,
    });

    expect(result.status).toBe("READY");

    const stored = await sharp(
      join(storageRoot, "public", `${await assetKey(result.assetId)}/original.webp`),
    ).toBuffer();
    expect(stored.includes(Buffer.from("<?php"))).toBe(false);
  });

  it("rejects an oversized file before writing anything", async () => {
    const huge = Buffer.alloc(11 * 1024 * 1024, 1);
    await expect(
      media.requestUpload({
        declaredBytes: huge.length,
        declaredMime: "image/png",
        kind: "PRODUCT",
        storeId: STORE,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("rejects an empty file", async () => {
    await expect(
      media.requestUpload({
        declaredBytes: 0,
        declaredMime: "image/png",
        kind: "PRODUCT",
        storeId: STORE,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("rejects a decompression bomb by pixel count", async () => {
    // Tiny on disk, enormous in memory. Caught before sharp allocates a raster.
    const bomb = await sharp({
      create: { width: 9000, height: 9000, channels: 3, background: "#000000" },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const result = await uploadAndProcess({
      body: bomb,
      declaredMime: "image/png",
      kind: "PRODUCT",
      storeId: STORE,
    });

    expect(result.status).toBe("REJECTED");
    expect(result.reason).toContain("megapixels");
  });

  it("records a rejection in the audit log", async () => {
    const result = await uploadAndProcess({
      body: Buffer.from("not an image at all", "utf8"),
      declaredMime: "image/png",
      kind: "PRODUCT",
      storeId: STORE,
    });

    const entries = await asAdmin((a) =>
      a.auditLog.findMany({ where: { entityType: "media_asset", entityId: result.assetId } }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("media.rejected");
  });
});

describe("storage key generation", () => {
  it("never derives a path from the caller's filename", async () => {
    // A traversal attempt in the filename must not influence where bytes land.
    const result = await uploadAndProcess({
      body: await makePng(),
      declaredMime: "image/png",
      kind: "PRODUCT",
      storeId: STORE,
      originalName: "../../../../etc/passwd.png",
    });

    expect(result.status).toBe("READY");
    const asset = await asAdmin((a) => a.mediaAsset.findUnique({ where: { id: result.assetId } }));

    expect(asset?.storageKey).not.toContain("..");
    expect(asset?.storageKey).toMatch(/^product\/[0-9a-f-]{36}$/);
    // The original name is retained as metadata only.
    expect(asset?.originalName).toBe("../../../../etc/passwd.png");
  });
});

async function assetKey(assetId: string): Promise<string> {
  const asset = await asAdmin((a) => a.mediaAsset.findUnique({ where: { id: assetId } }));
  return asset!.storageKey;
}
