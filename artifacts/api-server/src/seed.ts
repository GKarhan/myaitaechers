import { pool } from "@workspace/db";
import { logger } from "./lib/logger";

const A_HASH = "$2b$10$XNtFygoZfgWSvwuMn4FL9OYeBDsP0iON81K5QLknDbC.omeDWfVGe";
const T_HASH = "$2b$10$BakTUSKsLyy7aH1GqxKJ6e5SK2r.p6exfdZIpOy16uDdlwY3sEjmG";
const S_HASH = "$2b$10$Nhtlm4nZfjBGj74DxnicFeFX5k5f4sZsv7PUT3cDmBvaEEUBFpngq";

export async function seed() {
  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO users (username, password_hash, full_name, role)
      VALUES ('admin', '${A_HASH}', 'Ադministrator', 'admin')
      ON CONFLICT (username) DO NOTHING
    `);

    await client.query(`
      INSERT INTO users (username, password_hash, full_name, role)
      VALUES ('teacher1', '${T_HASH}', 'Լաուրա Քարhanyan', 'teacher')
      ON CONFLICT (username) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            role          = EXCLUDED.role
    `);

    await client.query(`
      INSERT INTO users (username, password_hash, full_name, role)
      VALUES ('admin', '${A_HASH}', 'Ադմինիստրատոր', 'admin')
      ON CONFLICT (username) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            role          = EXCLUDED.role
    `);
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
