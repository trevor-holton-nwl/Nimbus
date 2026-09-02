-- Drop redundant setup_matrix index
--
-- Why: idx_setup_matrix_plant_machine_version is a strict left-prefix of the
-- table's PRIMARY KEY (plant, machine, signature_version, from_key, to_key).
-- PostgreSQL's PK already creates a unique B-tree index usable for any prefix
-- query, so this separate index is redundant dead weight — it only adds write
-- cost with no read benefit. The PK index satisfies all queries that would
-- have used this index.
--
DROP INDEX IF EXISTS idx_setup_matrix_plant_machine_version;
