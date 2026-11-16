# Attendance Check-In System (Core Pipeline MVP)

Geofenced clock-in → WhatsApp notification to site PIC → one-tap web approval → Postgres record.

## Important: WhatsApp risk, read before relying on this

This uses **Baileys**, an unofficial library that connects as a regular WhatsApp Web
session on a real phone number — not Meta's official Business API. It's free, but:

- Automated use like this is outside WhatsApp's Terms of Service.
- Meta can detect and ban numbers that send many automated messages, with no
  guaranteed appeal.
- There's no way to make this fully "safe" from that risk, only lower it. This code
  paces outgoing messages (small random delay, one at a time) and sends plain text
  only — no bulk blasts, no templates, no interactive buttons — to look closer to
  normal human usage.
- **Have a fallback plan.** If the linked number gets banned or logged out, this
  channel stops working until you re-link a new number (and get every PIC to save
  the new contact). For anything you can't afford to have silently break, consider
  migrating this to Meta's official Cloud API later — the code is structured so only
  `src/whatsapp.js` would need to change.

## Architecture

```
frontend/checkin.html  → cleaner opens on their phone, submits GPS + employee code
backend (Express)      → verifies geofence, writes to Postgres, sends WhatsApp text
WhatsApp (Baileys)      → PIC receives a plain-text message with an approval link
frontend/approve.html  → PIC opens link, taps Approve/Reject
backend                → updates Postgres, single-use token prevents double actions
```

## Prerequisites

- Node.js 20+
- Docker + Docker Compose (optional, for Postgres + easy deployment)
- A WhatsApp number to dedicate to this bot (not your main personal number,
  so a ban doesn't affect your personal account)

## Setup — Option A: Docker Compose (recommended)

```bash
cd attendance-system
docker compose up --build
```

First run: the backend container needs you to scan a WhatsApp QR code.

```bash
docker compose logs -f backend
```

A QR code will print in the logs — scan it with the dedicated WhatsApp number via
**WhatsApp → Settings → Linked Devices → Link a device**. The session is saved to
`backend/auth/` (mounted as a volume), so you won't need to re-scan on restart
unless you log out or delete that folder.

The Postgres schema in `backend/schema.sql` is applied automatically on first
container start.

Once running:
- Clock-in page: `http://localhost:3000/checkin.html`
- Health check: `http://localhost:3000/health`

## Setup — Option B: Run locally without Docker

```bash
# 1. Start Postgres however you like, then:
cd attendance-system/backend
createdb attendance   # or use your own Postgres
psql attendance < schema.sql

# 2. Configure environment
cp .env.example .env
# edit .env — set DATABASE_URL to your Postgres connection string

# 3. Install and run
npm install
npm start
```

Scan the QR code printed in your terminal with the dedicated WhatsApp number.

## Adding your sites, PICs, and cleaners

This MVP has no admin UI yet (by design, for this first pass) — insert rows
directly:

```sql
INSERT INTO sites (name, latitude, longitude, radius_meters)
VALUES ('Menara ABC', 3.1569, 101.7123, 150);

INSERT INTO pics (site_id, name, whatsapp_number)
VALUES (1, 'Ahmad (PIC)', '60123456789');  -- country code, no + or spaces

INSERT INTO cleaners (site_id, name, employee_code)
VALUES (1, 'Siti Aminah', 'CLN-0001');
```

Get a site's lat/lng from Google Maps (right-click the exact spot → copy coordinates).

## How a check-in flows end to end

1. Cleaner opens `checkin.html` on their phone, enters their employee code, taps
   **Check In**. The browser asks for location permission.
2. Backend computes distance from the cleaner's GPS to the site's registered
   coordinates (Haversine formula in `src/geofence.js`).
3. If within `radius_meters`, a `checkins` row is created (`status = pending`)
   and a plain-text WhatsApp message with a unique approval link is queued to
   the site's PIC.
4. PIC taps the link, sees cleaner/site/time/distance, taps **Approve** or
   **Reject**. The token is single-use — the row is locked (`FOR UPDATE`)
   during the update so a double-tap can't process twice.
5. Postgres now holds the final, auditable record.

## What's deliberately NOT built yet (by your choice, for this first pass)

- Admin dashboard (viewing/exporting attendance, managing sites/PICs/cleaners
  via UI instead of SQL)
- Escalation if a PIC doesn't respond within N minutes
- Multiple PICs per site / fallback PIC
- Authentication on the clock-in page (currently anyone with an employee code
  and the URL can submit a check-in — fine for an internal pilot, not for
  production without adding at least a PIN or device binding)

Happy to build any of these next — say the word.
