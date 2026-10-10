-- Make chat_events a TimescaleDB hypertable partitioned on occurred_at (Tiger Data ships TimescaleDB).
-- Guarded so the same migrations also run on plain Postgres (local tests use PGlite, which has no TimescaleDB).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
    PERFORM create_hypertable('chat_events', by_range('occurred_at'), if_not_exists => TRUE, migrate_data => TRUE);
  END IF;
END
$$;
