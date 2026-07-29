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
      VALUES ('teacher1', '${T_HASH}', 'Լաուրա Քարհանյան', 'teacher')
      ON CONFLICT (username) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            role          = EXCLUDED.role
    `);

    await client.query(`
      INSERT INTO teachers (user_id, subjects, school, email)
      SELECT id, ARRAY[]::text[], '', NULL FROM users WHERE username = 'teacher1'
      ON CONFLICT (user_id) DO NOTHING
    `);

    // If teacher1 was deleted and recreated (new teachers.id), any classes that
    // previously pointed to the old teachers.id now have an orphaned teacher_id.
    // Reassign those orphaned classes to teacher1's current teachers.id so the
    // teacher dashboard always shows the right data after a restart.
    await client.query(`
      UPDATE classes
      SET teacher_id = (
        SELECT t.id FROM teachers t
        JOIN users u ON t.user_id = u.id
        WHERE u.username = 'teacher1'
        LIMIT 1
      )
      WHERE teacher_id NOT IN (SELECT id FROM teachers)
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
