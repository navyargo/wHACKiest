import "dotenv/config";
import { getDb } from "@carerelay/domain";
import { seedDemo, DEMO_PASSWORD, DEMO_USERS, demoEmail, demoMcpToken } from "@carerelay/demo";

async function main() {
  const db = getDb();
  const demo = process.env.DEMO_MODE === "true";
  const r = await seedDemo(db, { withMcpTokens: demo });
  console.log(`Seeded CareRelay demo data. Patient "Amma" = ${r.patientId}. Virtual demo time: ${r.demoNow.toISOString()}`);
  console.log(`Demo accounts (password "${DEMO_PASSWORD}", only when DEMO_MODE=true):`);
  for (const u of DEMO_USERS) console.log(`  ${demoEmail(u.key).padEnd(32)} ${u.role}${demo ? `   MCP token: ${demoMcpToken(u.key)}` : ""}`);
  await db.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
