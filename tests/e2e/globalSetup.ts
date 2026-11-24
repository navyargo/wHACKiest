import { execSync } from "node:child_process";
import { config } from "dotenv";

export default function setup() {
  config();
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL } });
}
