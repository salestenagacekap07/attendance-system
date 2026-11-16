-- Seed data for initial pipeline test.
-- Run after schema.sql, e.g.:
--   psql attendance < seed.sql
--   (or, with Docker Compose running) docker compose exec -T postgres psql -U attendance -d attendance < backend/seed.sql

INSERT INTO sites (name, latitude, longitude, radius_meters)
VALUES ('Sunway Grid', 3.019925, 101.536070, 20)
RETURNING id, name;

INSERT INTO pics (site_id, name, whatsapp_number)
VALUES (
  (SELECT id FROM sites WHERE name = 'Sunway Grid'),
  'Shiva',
  '60175314868'
)
RETURNING id, name, whatsapp_number;

INSERT INTO cleaners (site_id, name, employee_code)
VALUES (
  (SELECT id FROM sites WHERE name = 'Sunway Grid'),
  'Kiran',
  'CL01'
)
RETURNING id, name, employee_code;

