import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Single .env at the repo root (shared with Prisma, the seed and the stdio MCP server).
config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env") });

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@carerelay/domain", "@carerelay/agents", "@carerelay/mcp-server", "@carerelay/demo"],
  serverExternalPackages: ["@prisma/client", ".prisma/client", "bcryptjs", "unpdf"],
  experimental: { externalDir: true },
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
