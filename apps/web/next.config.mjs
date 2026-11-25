/* global process */
process.env.NEXT_IGNORE_INCORRECT_LOCKFILE = "1";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Single .env at the repo root (shared with Prisma, the seed and the stdio MCP server).
config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env") });

/** @type {import('next').NextConfig} */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nextConfig = {
  // Pin the workspace root to this repo (prevents Next from adopting a lockfile in a parent folder).
  outputFileTracingRoot: repoRoot,
  transpilePackages: ["@carerelay/domain", "@carerelay/agents", "@carerelay/mcp-server", "@carerelay/demo"],
  serverExternalPackages: ["@prisma/client", ".prisma/client", "bcryptjs", "unpdf"],
  // Lets E2E run its own server alongside `pnpm dev` without sharing build output.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: { externalDir: true },
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
