import { execSync } from "node:child_process";
import { config } from "dotenv";

export default function setup() {
  config();
  if (process.env.TEST_DATABASE_URL) {
    try {
      execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL } });
    } catch (e) {
      console.warn("Could not deploy prisma migrations for test database:", (e as Error).message);
    }
  }
}
