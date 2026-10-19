-- Additive only. Apply before deploying the durable-upload code.
CREATE TABLE IF NOT EXISTS uploaded_files (
  filename text PRIMARY KEY,
  data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 104857600),
  mime_type text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
