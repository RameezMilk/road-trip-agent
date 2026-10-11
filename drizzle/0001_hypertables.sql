-- Make chat_events and trip_events TimescaleDB hypertables partitioned on occurred_at (Tiger Data ships TimescaleDB).
-- Guarded so the same migrations also run on plain Postgres (tests use PGlite, which has no TimescaleDB).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
    PERFORM create_hypertable('chat_events', by_range('occurred_at'), if_not_exists => TRUE, migrate_data => TRUE);
    PERFORM create_hypertable('trip_events', by_range('occurred_at'), if_not_exists => TRUE, migrate_data => TRUE);
  END IF;
END
$$;
