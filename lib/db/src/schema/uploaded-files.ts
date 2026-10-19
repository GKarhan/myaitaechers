import { pgTable, text, timestamp, customType, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
// File bytes are private backend data and must never be included in list DTOs.
export const uploadedFilesTable = pgTable("uploaded_files", {
  filename: text("filename").primaryKey(),
  data: bytea("data").notNull(),
  mimeType: text("mime_type").notNull(),
  sha256: text("sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("uploaded_files_data_check", sql`octet_length(${table.data}) BETWEEN 1 AND 104857600`),
  check("uploaded_files_sha256_check", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
]);
