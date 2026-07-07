import { pool } from "@workspace/db";
import { logger } from "./lib/logger";

const A_HASH = "$2b$10$XNtFygoZfgWSvwuMn4FL9OYeBDsP0iON81K5QLknDbC.omeDWfVGe";

export async function seed() {
  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO users (username, password_hash, full_name, role)
      VALUES ('admin', '${A_HASH}', 'Ադministrator', 'admin')
      ON CONFLICT (username) DO NOTHING
    `);
    // Keep student1 name in sync with ekarhanyan (the real student account)
    await client.query(`
      UPDATE users
      SET full_name = (SELECT full_name FROM users WHERE username = 'ekarhanyan')
      WHERE username = 'student1'
        AND EXISTS (SELECT 1 FROM users WHERE username = 'ekarhanyan')
    `);
    logger.info("Seed completed");
  } catch (err) {
    logger.error({ err }, "Seed failed");
  } finally {
    client.release();
  }
}
