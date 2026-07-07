import { pool } from "@workspace/db";
import { logger } from "./lib/logger";

const A_HASH = "$2b$10$XNtFygoZfgWSvwuMn4FL9OYeBDsP0iON81K5QLknDbC.omeDWfVGe";

export async function seed() {
  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO users (username, password_hash, full_name, role)
      VALUES ('admin', '${A_HASH}', 'Ադմինիստրատոր', 'admin')
      ON CONFLICT (username) DO NOTHING
    `);
    logger.info("Seed completed");
  } catch (err) {
    logger.error({ err }, "Seed failed");
  } finally {
    client.release();
  }
}
