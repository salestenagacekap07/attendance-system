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
    pic_name TEXT,
    pic_phone TEXT,
    pic_email TEXT,
    opening_date DATE DEFAULT CURRENT_DATE,
    working_days_pattern TEXT DEFAULT 'Mon-Fri',
    working_time_start TEXT DEFAULT '09:00',
    working_time_end TEXT DEFAULT '17:00',
    break_time_minutes INTEGER DEFAULT 60,
    allowed_worker_types JSONB DEFAULT '["Cleaner", "General Worker", "Landscaper"]'::jsonb,
    landscaper_salary_type TEXT DEFAULT 'monthly',
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
    worker_type TEXT NOT NULL DEFAULT 'Cleaner',
    salary_type TEXT NOT NULL DEFAULT 'monthly',
    base_salary NUMERIC(10,2) NOT NULL DEFAULT 1500.00,
    phone TEXT,
    status TEXT DEFAULT 'active',
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
    device_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_checkins_status ON checkins(status);
CREATE INDEX IF NOT EXISTS idx_checkins_token ON checkins(approval_token);
CREATE INDEX IF NOT EXISTS idx_checkins_cleaner ON checkins(cleaner_id, created_at);

CREATE TABLE IF NOT EXISTS daily_attendance (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    worker_id INTEGER NOT NULL REFERENCES cleaners(id) ON DELETE CASCADE,
    attendance_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'Present',
    in_time TEXT,
    out_time TEXT,
    ot_hours NUMERIC(5,2) DEFAULT 0,
    late_hours NUMERIC(5,2) DEFAULT 0,
    remarks TEXT,
    source TEXT DEFAULT 'manual',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_site_worker_date UNIQUE (site_id, worker_id, attendance_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_att_site_date ON daily_attendance(site_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_daily_att_worker ON daily_attendance(worker_id, attendance_date);

CREATE TABLE IF NOT EXISTS public_holidays (
    id SERIAL PRIMARY KEY,
    holiday_date DATE UNIQUE NOT NULL,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payroll_reports (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    report_data JSONB NOT NULL,
    sent_to_email TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);
