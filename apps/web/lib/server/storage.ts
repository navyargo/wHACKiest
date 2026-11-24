/** StorageProvider: local disk by default, S3 when STORAGE_PROVIDER=s3. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StorageProvider {
  name: "local" | "s3";
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

function local(): StorageProvider {
  const root = path.resolve(process.cwd(), process.env.LOCAL_STORAGE_DIR?.startsWith("/") ? process.env.LOCAL_STORAGE_DIR : path.join("../..", process.env.LOCAL_STORAGE_DIR || "./storage"));
  const safe = (key: string) => {
    const p = path.resolve(root, key);
    if (!p.startsWith(root)) throw new Error("Invalid storage key");
    return p;
  };
  return {
    name: "local",
    async put(key, bytes) {
      const p = safe(key);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, bytes);
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(safe(key)));
      } catch {
        return null;
      }
    },
  };
}

function s3(): StorageProvider {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("STORAGE_PROVIDER=s3 requires S3_BUCKET");
  const load = async () => {
    const m = await import("@aws-sdk/client-s3");
    return { m, client: new m.S3Client({ region: process.env.AWS_REGION }) };
  };
  return {
    name: "s3",
    async put(key, bytes, contentType) {
      const { m, client } = await load();
      await client.send(new m.PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }));
    },
    async get(key) {
      const { m, client } = await load();
      try {
        const r = await client.send(new m.GetObjectCommand({ Bucket: bucket, Key: key }));
        return r.Body ? await r.Body.transformToByteArray() : null;
      } catch {
        return null;
      }
    },
  };
}

let cached: StorageProvider | null = null;
export function storage(): StorageProvider {
  if (!cached) cached = process.env.STORAGE_PROVIDER === "s3" ? s3() : local();
  return cached;
}
