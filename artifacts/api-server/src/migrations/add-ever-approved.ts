import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  await db.execute(sql`ALTER TABLE lessons ADD COLUMN IF NOT EXISTS ever_approved BOOLEAN NOT NULL DEFAULT FALSE`);
  // Backfill: any lesson that is currently approved/active/assigned/completed has been approved at least once
  await db.execute(sql`
    UPDATE lessons SET ever_approved = TRUE
    WHERE status IN ('approved', 'active', 'assigned', 'completed')
  `);
  console.log("Migration done: ever_approved column added and backfilled");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
