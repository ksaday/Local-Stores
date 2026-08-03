import type { LocalDiskOptions } from "./storage.provider.js";

/**
 * Storage options for tests.
 *
 * Exists so a signature change to `LocalDiskStorage` touches one place rather
 * than every suite that happens to need a disk.
 */
export function testStorage(root: string, publicBaseUrl = "http://localhost:3100/media"): LocalDiskOptions {
  return {
    root,
    publicBaseUrl,
    uploadBaseUrl: "http://localhost:3100/api/v1/media/upload",
    uploadSecret: "test-upload-secret",
  };
}
