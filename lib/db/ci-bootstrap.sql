-- Fresh CI databases only. Drizzle currently emits the composite child FK
-- before its referenced unique index. Establish that index before the second
-- reconciliation; production schema/migrations are not changed here.
CREATE UNIQUE INDEX IF NOT EXISTS lesson_nodes_id_lesson_uidx ON lesson_nodes (id, lesson_id);
