ALTER TABLE tasks
  ADD COLUMN inherit_parent_context INTEGER NOT NULL DEFAULT 0;
