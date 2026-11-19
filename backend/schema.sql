-- Attendance System schema
-- Run once against your Postgres database.

CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO clients (name)
SELECT 'Default Client'
WHERE NOT EXISTS (SELECT 1 FROM clients WHERE name = 'Default Client');

CREATE TABLE IF NOT EXISTS sites (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    radius_meters DOUBLE PRECISION NOT NULL DEFAULT 150,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pics (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    whatsapp_number TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cleaners (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    employee_code TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'checkin_status') THEN
    CREATE TYPE checkin_status AS ENUM ('pending', 'approved', 'rejected', 'expired');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS checkins (
    id SERIAL PRIMARY KEY,
    cleaner_id INTEGER NOT NULL REFERENCES cleaners(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    distance_meters DOUBLE PRECISION NOT NULL,
    within_geofence BOOLEAN NOT NULL,
    status checkin_status NOT NULL DEFAULT 'pending',
    action_type VARCHAR(20) NOT NULL DEFAULT 'time_in',
    remark TEXT,
    approval_token TEXT UNIQUE NOT NULL,
    pic_id INTEGER REFERENCES pics(id) ON DELETE SET NULL,
    photo_data TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_checkins_status ON checkins(status);
CREATE INDEX IF NOT EXISTS idx_checkins_token ON checkins(approval_token);
CREATE INDEX IF NOT EXISTS idx_checkins_cleaner ON checkins(cleaner_id, created_at);

CREATE TABLE IF NOT EXISTS whatsapp_auth (
    id TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
