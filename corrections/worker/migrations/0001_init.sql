-- Reader reports. `body` is the validated report as JSON: the tree snapshot, the
-- proposed fix and the reader's note. The reporter's email is a column of its own so the
-- daily job can null it out 90 days after a decision; it never leaves this database
-- except in the review email.
CREATE TABLE reports (
  id            TEXT PRIMARY KEY,
  received      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | denied | closed
  kind          TEXT NOT NULL,
  struct_id     TEXT NOT NULL,
  body          TEXT NOT NULL,
  email         TEXT,
  decided_at    TEXT,
  decision_note TEXT,
  correction_id TEXT,
  commit_sha    TEXT
);
CREATE INDEX reports_struct ON reports (struct_id);
CREATE INDEX reports_status ON reports (status, received);

-- Rate limiting. `who` is a keyed hash of the client IP, never the IP itself.
CREATE TABLE hits (
  who TEXT NOT NULL,
  at  INTEGER NOT NULL
);
CREATE INDEX hits_who_at ON hits (who, at);
