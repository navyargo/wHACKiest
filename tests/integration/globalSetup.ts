import { execSync } from "node:child_process";
import path from "node:path";
import { config } from "dotenv";

export default function setup() {
  config({ path: path.resolve(__dirname, "../../.env") });
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL } });
}
