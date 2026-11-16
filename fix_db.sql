CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO clients (name)
SELECT 'Default Client'
WHERE NOT EXISTS (SELECT 1 FROM clients WHERE name = 'Default Client');

ALTER TABLE sites ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL;
UPDATE sites
SET client_id = (SELECT id FROM clients WHERE name = 'Default Client')
WHERE client_id IS NULL;

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

DO echo hello
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'checkin_status') THEN
    CREATE TYPE checkin_status AS ENUM ('pending', 'approved', 'rejected', 'expired');
  END IF;
ENDecho hello;

CREATE TABLE IF NOT EXISTS checkins (
    id SERIAL PRIMARY KEY,
    cleaner_id INTEGER NOT NULL REFERENCES cleaners(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    distance_meters DOUBLE PRECISION NOT NULL,
    within_geofence BOOLEAN NOT NULL,
    status checkin_status NOT NULL DEFAULT 'pending',
    approval_token TEXT UNIQUE NOT NULL,
    pic_id INTEGER REFERENCES pics(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_checkins_status ON checkins(status);
CREATE INDEX IF NOT EXISTS idx_checkins_token ON checkins(approval_token);
CREATE INDEX IF NOT EXISTS idx_checkins_cleaner ON checkins(cleaner_id, created_at);
