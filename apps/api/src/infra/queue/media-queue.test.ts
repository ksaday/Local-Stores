import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { LocalDiskStorage } from "../../infra/storage/storage.provider.js";
import { AuditService } from "../../modules/audit/audit.service.js";
import { MediaService } from "../../modules/media/media.service.js";
import { MediaProcessor } from "../../worker/media-processor.js";
import { PROCESS_IMAGE_JOB } from "./media-queue.js";
import { MediaQueue } from "./queue.module.js";

const APP_DATABASE_URL =
  process.env.DATABASE_URL_APP ?? "postgresql://bba_app@localhost:5432/bba_dev?schema=public";

const STORE = "f5000000-0000-4000-8000-00000000000a";
const OWNER = "f5000000-0000-4000-8000-000000000001";

const config = {
  get: (key: string) =>
    key === "REDIS_URL" ? (process.env.REDIS_URL ?? "redis://localhost:6379") : "test",
} as never;

let prisma: PrismaService;
let media: MediaService;
let queue: MediaQueue;
let processor: MediaProcessor | undefined;
let storageRoot: string;
let queueName: string;

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "bba-mediaq-"));
  prisma = new PrismaService({ datasources: { db: { url: APP_DATABASE_URL } } } as never);
  await seed();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  queueName = `test-media-${randomUUID().slice(0, 8)}`;
  queue = new MediaQueue(config, queueName);
  media = new MediaService(
    prisma,
    new LocalDiskStorage(storageRoot, "http://localhost:3100/media"),
    new AuditService(prisma),
    queue,
  );
  processor = undefined;
  await asAdmin((a) => a.$executeRaw`DELETE FROM media_assets WHERE store_id = ${STORE}`);
});

afterEach(async () => {
  await processor?.stop();
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
      VALUES (${OWNER}, 'mediaq-owner@example.com'::citext, 'Owner', 'ACTIVE', now(), now())`;
    await admin.$executeRaw`
      INSERT INTO stores (id, slug, name, business_type, status, owner_user_id, timezone,
                          currency, branding, cash_enabled, stripe_charges_enabled,
                          platform_fee_bps, created_at, updated_at)
      VALUES (${STORE}, 'mediaq-store'::citext, 'Media Queue Store', 'RETAIL', 'ACTIVE', ${OWNER},
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

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition never became true");
}

function png(width = 400, height = 300): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#cc4422" } })
    .png()
    .toBuffer();
}

/**
 * Whether a quarantined upload is still on disk.
 *
 * Checked per file rather than by listing the directory: the first test
 * deliberately never processes its upload, so its bytes stay there for the
 * whole run and a directory-level assertion would see them.
 */
async function quarantineExists(key: string): Promise<boolean> {
  return access(join(storageRoot, "quarantine", key)).then(
    () => true,
    () => false,
  );
}

async function statusOf(assetId: string): Promise<string> {
  const [row] = await asAdmin(
    (a) => a.$queryRaw<{ status: string }[]>`
      SELECT status::text FROM media_assets WHERE id = ${assetId}`,
  );
  return row?.status ?? "GONE";
}

describe("the media queue", () => {
  it("returns before the image is processed, leaving it PENDING", async () => {
    const result = await media.upload({
      body: await png(),
      declaredMime: "image/png",
      kind: "PRODUCT",
      storeId: STORE,
    });

    // The point of the whole change: the caller is not waiting on sharp.
    expect(result.status).toBe("PENDING");
    expect(result.url).toBeNull();
    expect(await statusOf(result.assetId)).toBe("PENDING");

    const [job] = await queue.waiting();
    expect(job!.name).toBe(PROCESS_IMAGE_JOB);
    expect(job!.data.assetId).toBe(result.assetId);
    // The bytes stay in quarantine; only the id travels through Redis.
    expect(JSON.stringify(job!.data).length).toBeLessThan(200);
  });

  it("processes the image once the worker picks it up", async () => {
    const result = await media.upload({
      body: await png(),
      declaredMime: "image/png",
      kind: "PRODUCT",
      storeId: STORE,
    });

    const [queued] = await queue.waiting();
    const quarantineKey = queued!.data.quarantineKey;

    processor = new MediaProcessor(media, config, queueName);
    processor.start();

    await until(async () => (await statusOf(result.assetId)) === "READY");

    const ready = await media.status(result.assetId, { storeId: STORE, isSuperAdmin: false });
    expect(ready.status).toBe("READY");
    expect(ready.url).toContain("original.webp");
    // The unvalidated copy does not outlive the job that validated it.
    expect(await quarantineExists(quarantineKey)).toBe(false);
  });

  it("records a verdict on a file that is not really an image", async () => {
    // Declared as a PNG, actually a shell script. The magic-byte check runs on
    // the worker now, but it still runs before anything reaches the public
    // prefix — that is the property that must not have moved.
    const result = await media.upload({
      body: Buffer.from("#!/bin/sh\nrm -rf /\n"),
      declaredMime: "image/png",
      kind: "PRODUCT",
      storeId: STORE,
    });

    processor = new MediaProcessor(media, config, queueName);
    processor.start();

    await until(async () => (await statusOf(result.assetId)) === "REJECTED");

    // A verdict, not a failure: retrying would decode the same bytes to the
    // same answer, so the job completed rather than exhausting its attempts.
    expect(await queue.deadLettered()).toBe(0);
    const rejected = await media.status(result.assetId, { storeId: STORE, isSuperAdmin: false });
    expect(rejected.reason).toBeTruthy();
    expect(rejected.url).toBeNull();
  });

  it("cleans up after an asset deleted before its job ran", async () => {
    const result = await media.upload({
      body: await png(),
      declaredMime: "image/png",
      kind: "PRODUCT",
      storeId: STORE,
    });
    const [queued] = await queue.waiting();
    const quarantineKey = queued!.data.quarantineKey;
    await asAdmin((a) => a.$executeRaw`DELETE FROM media_assets WHERE id = ${result.assetId}`);

    processor = new MediaProcessor(media, config, queueName);
    processor.start();

    // Neither a crash nor a retry loop, and no orphaned bytes left behind.
    await until(async () => !(await quarantineExists(quarantineKey)));
    expect(await queue.deadLettered()).toBe(0);
  });
});
