import { pool } from "@workspace/db";
  import { logger } from "./lib/logger";

  const S_HASH = "$2b$10$PYTzLiv2NcLuk7PjU9XtF.seBV4FroQZ6tWWaCTK3ftGV4O.sjzJm";
  const A_HASH = "$2b$10$XNtFygoZfgWSvwuMn4FL9OYeBDsP0iON81K5QLknDbC.omeDWfVGe";
  const T_HASH = "$2b$10$.Yi5bBKMF4fMPHEEa8CpcutcF3HOH4xtTwI8Cgg7wg5QOv4VVIQPO";

  export async function seed() {
    const client = await pool.connect();
    try {
      await client.query(`
        INSERT INTO users (username, password_hash, full_name, role) VALUES
          ('student1', '${S_HASH}', 'Aram Karapetyan', 'student'),
          ('admin',    '${A_HASH}', 'Administrator',   'admin'),
          ('teacher1', '${T_HASH}', 'Aret Hakobyan',   'teacher')
        ON CONFLICT (username) DO UPDATE
          SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
      `);

      await client.query(`
        INSERT INTO teachers (user_id, subject, school)
        SELECT id, 'Mathematics', 'Karhanyan School'
        FROM users WHERE username = 'teacher1'
        ON CONFLICT (user_id) DO NOTHING
      `);

      await client.query(`
        INSERT INTO classes (name, grade, teacher_id)
        SELECT '10A', '10th', t.id
        FROM teachers t JOIN users u ON t.user_id = u.id
        WHERE u.username = 'teacher1'
        ON CONFLICT DO NOTHING
      `);

      await client.query(`
        INSERT INTO schedule (class_id, day, time, subject)
        SELECT c.id, v.day, v.time, v.subject
        FROM classes c
        JOIN teachers t ON c.teacher_id = t.id
        JOIN users u ON t.user_id = u.id AND u.username = 'teacher1'
        CROSS JOIN (VALUES
          ('Երկուշաբթի', '09:00', 'Mathematics'),
          ('Երկուշաբթի', '10:00', 'Armenian Language'),
          ('Երեքշաբթի', '09:00', 'Physics'),
          ('Չորեքշաբթի', '11:00', 'History'),
          ('Հինգշաբթի', '09:00', 'English'),
          ('Ուրբաթ', '10:00', 'Mathematics')
        ) AS v(day, time, subject)
        ON CONFLICT DO NOTHING
      `);

      await client.query(`
        INSERT INTO class_students (class_id, student_id)
        SELECT c.id, s.id
        FROM classes c
        JOIN teachers t ON c.teacher_id = t.id
        JOIN users tu ON t.user_id = tu.id AND tu.username = 'teacher1'
        CROSS JOIN (SELECT id FROM users WHERE username = 'student1') s
        ON CONFLICT DO NOTHING
      `);

      await client.query(`
        INSERT INTO student_progress (user_id, subject, lesson, score, status)
        SELECT u.id, v.subject, v.lesson, v.score, v.status::text
        FROM users u
        CROSS JOIN (VALUES
          ('Mathematics',      'Algebra',    92, 'graded'),
          ('Mathematics',      'Geometry',   78, 'graded'),
          ('Physics',          'Mechanics',  88, 'graded'),
          ('English',          'Grammar',    75, 'graded'),
          ('History',          'Ancient',    95, 'graded'),
          ('Armenian Language','Morphology', 85, 'graded'),
          ('History',          'Medieval',   60, 'not_submitted'),
          ('English',          'Writing',     0, 'not_submitted'),
          ('Armenian Language','Syntax',     70, 'pending')
        ) AS v(subject, lesson, score, status)
        WHERE u.username = 'student1'
        ON CONFLICT DO NOTHING
      `);

      logger.info("Seed completed");
    } catch (err) {
      logger.error({ err }, "Seed failed");
    } finally {
      client.release();
    }
  }
  