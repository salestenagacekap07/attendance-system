# Facility & Cleaning Operations Attendance & Payroll System (Malaysia)

A full-stack Operations (OPS) Dashboard, geofenced mobile attendance system, 1-tap PIC WhatsApp approval workflow, and Malaysian payroll calculation engine hosted on **Render Cloud** and **Render Managed PostgreSQL**.

---

## Live Production URLs

| Surface | URL | Purpose |
|---|---|---|
| **OPS Dashboard** | `https://attendance-system-rbay.onrender.com/operations.html` | Site setup, worker directory, monthly attendance, payroll engine, public holidays & Accounts reports (Desktop & Mobile responsive) |
| **Cleaner Check-In** | `https://attendance-system-rbay.onrender.com/checkin.html` | Mobile GPS geofenced Time-In / Time-Out with live selfie capture |
| **PIC 1-Tap Approval** | `https://attendance-system-rbay.onrender.com/approve.html?token=<uuid>` | Single-use PIC verification page (no PIN required; anti-self-approval device lockout active) |
| **Health Check** | `https://attendance-system-rbay.onrender.com/api/health` | Service status & keep-alive monitor |

---

## System Architecture

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                         Render Cloud (Node / Express)                   │
│                                                                         │
│  Frontend (Static HTML/JS, Mobile-Responsive, No-Cache)                 │
│   ├── operations.html  → OPS Dashboard, Attendance, Payroll, Holidays   │
│   ├── checkin.html     → Cleaner GPS Geofence + Live Selfie Clock-In    │
│   └── approve.html     → PIC 1-Tap Phone Verification                   │
│                                                                         │
│  Backend API (Express)                                                  │
│   ├── /api/checkin     → Haversine geofence check + pending record      │
│   ├── /api/approve     → Single-use token lock + sync daily_attendance  │
│   ├── /api/operations  → Sites, Workers, Attendance, Payroll, Holidays  │
│   └── /api/health      → Health check + 8-min self-ping keep-alive      │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────────┐
        ▼                       ▼                           ▼
Render PostgreSQL       Direct 1-Tap WhatsApp       Accounts Reporting
(Singapore Cloud)       (https://wa.me/...)         (acctcm06@gmail.com)
- sites                 - No Baileys / QR pairing   - 1-Click Gmail Compose
- cleaners / pics       - No Evolution API / n8n    - Optional Nodemailer SMTP
- checkins              - Zero ban risk             - 1-Page Landscape A4 PDF
- daily_attendance                                  - DB audit log
- public_holidays
- payroll_reports
```

### Key Architectural Decisions
- **Direct 1-Tap WhatsApp Gateway:** Uses official `https://wa.me/<phone>?text=...` links instead of unofficial WhatsApp bots (Baileys / Evolution API were removed). No QR pairing, no background session maintenance, and zero account ban risk.
- **Cloud-Native Persistence:** All production data lives in Render Managed PostgreSQL (Singapore). Auto-migrations run automatically on boot (`backend/src/migrate.js`). Local Docker is not required for production.
- **Zero-Friction PIC Sync:** When a PIC taps **Approve** on their phone via `approve.html`, the backend automatically updates `daily_attendance`, calculates late/OT hours, and reflects it in the monthly attendance sheet and payroll engine.

---

## Core Modules

### 1. Site Management
- Create and edit client sites with Site Name, PIC Name, PIC WhatsApp Phone, PIC Email, Site Opening Date, and GPS Latitude/Longitude (with 1-tap geolocation).
- **Interactive Working Days Pattern:** Tick any combination of days (`Mon` through `Sun`) with quick presets (`Mon - Fri`, `Mon - Sat`, `All 7 Days`).
- Configurable shift start/end times and **unpaid break duration** (excluded from payable hours).
- Configurable allowed worker categories per site (`Cleaner`, `General Worker`, `Landscaper`).

### 2. Worker Directory & Salary Basis
- Manage workers by site, category, and employee code.
- **Flexible Worker Salary Basis:** Configure **Monthly Salary** or **Daily Salary** per individual worker across Cleaners, General Workers, and Landscapers.

### 3. Daily Attendance Sheet & Monthly Roster
- Record daily attendance statuses: `Present`, `Absent`, `Half Day`, `Leave`, `OT`, with In/Out times, Late hours, OT hours, and remarks.
- **Auto-Generate Monthly Schedule:** 1-click schedule population for all workers at a site based on the site's ticked working days and public holidays (never overwrites existing records or PIC mobile approvals).
- **Monthly Attendance Summary:** Automatically counts total times attended per worker (Normal days, Sunday work, PH work, Absences, Half days, and OT hours).
- **20-Year Selector Horizon:** Supports years **2025 through 2046**.

### 4. Malaysian Public Holidays Manager
- Pre-seeded with Malaysian national & state public holidays (including 18 holidays for 2026 and fixed national holidays through 2046).
- Built-in **Public Holidays Manager** modal in the OPS Dashboard to view, add (state holidays, ad-hoc government holidays), or delete holidays by year. Changes immediately update working-day counts and payroll calculations.

### 5. Malaysian Salary Calculation Engine (`backend/src/salaryCalculator.js`)
- **Auto-Counted Working Days:** Counts scheduled working days in the selected calendar month based on the site's ticked days pattern. Excludes Public Holidays by default; automatically counts a PH day as a working day if the worker attended (`Present` / `OT` / `Half Day`).
- **Hourly & Daily Rates (Monthly Workers):**
  - `Per Day Salary = Monthly Base Salary ÷ Auto-Counted Working Days`
  - `Net Working Hours = (Out Time − In Time) − Unpaid Break`
  - `Per Hour Salary = Per Day Salary ÷ Net Working Hours`
- **Deductions:**
  - Absent: `1 × Per Day Salary`
  - Half Day: `0.5 × Per Day Salary`
  - Late: `Late Hours × Per Hour Salary`
- **Overtime Multipliers:**
  - Normal Working Days (Mon–Sat): **`1.5×` Per Hour Salary**
  - Rest Days (Sunday) & Public Holidays (PH): **`2.0×` Per Hour Salary**
- **Accounts Reporting & Export:**
  - Explicit **Days Worked Breakdown Formula** per worker (e.g. `20 Normal Working Days + 1 Sunday = Total 21 Days`).
  - **1-Page Landscape A4 Print / PDF Statement** with executive summary and OPS / Accounts sign-off signature blocks.
  - **Send to Accounts (`acctcm06@gmail.com`):** Pre-filled Gmail Web Compose launch, copyable plain-text summary, optional SMTP via `nodemailer`, and audit logging in `payroll_reports`.

---

## Project Structure

```text
attendance-system/
├── backend/
│   ├── package.json
│   ├── schema.sql                # Base PostgreSQL schema
│   ├── seed.sql                  # Optional sample seed data
│   └── src/
│       ├── index.js              # Express server, static serving, auto-migrate, keep-alive
│       ├── db.js                 # PostgreSQL connection pool (SSL-enabled for Render)
│       ├── migrate.js            # Idempotent schema migrations & public holiday seeding
│       ├── geofence.js           # Haversine GPS distance calculation
│       ├── salaryCalculator.js   # Working-day counter, deductions, 1.5x/2.0x OT, formulas
│       ├── whatsapp.js           # Lightweight phone helper & direct-gateway stub
│       └── routes/
│           ├── checkin.js        # Cleaner GPS/selfie check-in & WhatsApp link builder
│           ├── approve.js        # PIC 1-tap approval, lockout check, attendance sync
│           ├── operations.js     # Full OPS Dashboard, Payroll, Email & Holidays API
│           └── pair.js           # Health & legacy gateway status endpoint
└── frontend/
    ├── operations.html           # Main OPS Dashboard & Payroll Engine (Responsive)
    ├── checkin.html              # Cleaner mobile clock-in UI
    ├── approve.html              # PIC mobile 1-tap approval UI
    └── pair.html                 # Legacy status page
```

---

## Environment Variables

Configure these in Render (or `backend/.env` for local runs):

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (`postgres://...`) |
| `PUBLIC_BASE_URL` | Yes | Public app URL (e.g. `https://attendance-system-rbay.onrender.com`) used for approval links & keep-alive |
| `PORT` | No | HTTP port (defaults to `3000`) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | No | Optional SMTP credentials for headless email delivery alongside direct Gmail Compose |

---

## Running Locally & Deploying

### Local Development
```bash
cd backend
npm install
npm start
```
The server starts on `http://localhost:3000`, runs `migrate()` automatically against `DATABASE_URL`, and serves:
- OPS Dashboard: `http://localhost:3000/operations.html`
- Cleaner Check-In: `http://localhost:3000/checkin.html`

### Production Deployment (Render)
Render is linked directly to the `main` branch on GitHub. Pushing commits automatically triggers a live cloud rebuild and zero-touch migration:
```bash
git add .
git commit -m "Describe your change"
git push origin main
```
