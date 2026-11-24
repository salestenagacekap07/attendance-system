const { pool } = require('./db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Update sites table
    const siteCols = [
      'ALTER TABLE sites ADD COLUMN IF NOT EXISTS pic_name TEXT;',
      'ALTER TABLE sites ADD COLUMN IF NOT EXISTS pic_phone TEXT;',
      'ALTER TABLE sites ADD COLUMN IF NOT EXISTS pic_email TEXT;',
      'ALTER TABLE sites ADD COLUMN IF NOT EXISTS opening_date DATE DEFAULT CURRENT_DATE;',
      'ALTER TABLE sites ADD COLUMN IF NOT EXISTS working_days_pattern TEXT DEFAULT \'Mon-Fri\';',
      'ALTER TABLE sites ADD COLUMN IF NOT EXISTS working_time_start TEXT DEFAULT \'09:00\';',
      'ALTER TABLE sites ADD COLUMN IF NOT EXISTS working_time_end TEXT DEFAULT \'17:00\';',
      'ALTER TABLE sites ADD COLUMN IF NOT EXISTS break_time_minutes INTEGER DEFAULT 60;',
      'ALTER TABLE sites ADD COLUMN IF NOT EXISTS allowed_worker_types JSONB DEFAULT \'["Cleaner", "General Worker", "Landscaper"]\'::jsonb;',
      'ALTER TABLE sites ADD COLUMN IF NOT EXISTS landscaper_salary_type TEXT DEFAULT \'monthly\';'
    ];
    for (const sql of siteCols) {
      await client.query(sql);
    }

    // Sync existing pics to sites if empty
    await client.query(`
      UPDATE sites s
      SET pic_name = COALESCE(s.pic_name, p.name),
          pic_phone = COALESCE(s.pic_phone, p.whatsapp_number)
      FROM pics p
      WHERE p.site_id = s.id AND (s.pic_name IS NULL OR s.pic_phone IS NULL);
    `);

    // 2. Update cleaners (workers) table
    const workerCols = [
      'ALTER TABLE cleaners ADD COLUMN IF NOT EXISTS worker_type TEXT DEFAULT \'Cleaner\';',
      'ALTER TABLE cleaners ADD COLUMN IF NOT EXISTS salary_type TEXT DEFAULT \'monthly\';',
      'ALTER TABLE cleaners ADD COLUMN IF NOT EXISTS base_salary NUMERIC(10,2) DEFAULT 1500.00;',
      'ALTER TABLE cleaners ADD COLUMN IF NOT EXISTS phone TEXT;',
      'ALTER TABLE cleaners ADD COLUMN IF NOT EXISTS status TEXT DEFAULT \'active\';'
    ];
    for (const sql of workerCols) {
      await client.query(sql);
    }

    // 3. Create daily_attendance table
    await client.query(`
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
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        CONSTRAINT uq_site_worker_date UNIQUE (site_id, worker_id, attendance_date)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_att_site_date ON daily_attendance(site_id, attendance_date);
      CREATE INDEX IF NOT EXISTS idx_daily_att_worker ON daily_attendance(worker_id, attendance_date);
    `);

    // 4. Create public_holidays table
    await client.query(`
      CREATE TABLE IF NOT EXISTS public_holidays (
        id SERIAL PRIMARY KEY,
        holiday_date DATE UNIQUE NOT NULL,
        name TEXT NOT NULL
      );
    `);

    // Seed Malaysian public holidays 2025 & 2026
    const holidays = [
      ['2025-01-01', 'New Year Day'],
      ['2025-01-29', 'Chinese New Year Day 1'],
      ['2025-01-30', 'Chinese New Year Day 2'],
      ['2025-02-11', 'Thaipusam'],
      ['2025-03-31', 'Hari Raya Aidilfitri Day 1'],
      ['2025-04-01', 'Hari Raya Aidilfitri Day 2'],
      ['2025-05-01', 'Labour Day'],
      ['2025-05-12', 'Wesak Day'],
      ['2025-06-02', 'YDPA Agong Birthday'],
      ['2025-06-07', 'Hari Raya Haji'],
      ['2025-06-27', 'Awal Muharram'],
      ['2025-08-31', 'National Day (Merdeka)'],
      ['2025-09-05', 'Maulidur Rasul'],
      ['2025-09-16', 'Malaysia Day'],
      ['2025-10-20', 'Deepavali'],
      ['2025-12-25', 'Christmas Day'],
      ['2026-01-01', 'New Year Day'],
      ['2026-02-01', 'Thaipusam'],
      ['2026-02-17', 'Chinese New Year Day 1'],
      ['2026-02-18', 'Chinese New Year Day 2'],
      ['2026-03-20', 'Hari Raya Aidilfitri Day 1'],
      ['2026-03-21', 'Hari Raya Aidilfitri Day 2'],
      ['2026-05-01', 'Labour Day'],
      ['2026-05-31', 'Wesak Day'],
      ['2026-06-01', 'YDPA Agong Birthday'],
      ['2026-06-17', 'Awal Muharram'],
      ['2026-08-31', 'National Day (Merdeka)'],
      ['2026-09-16', 'Malaysia Day'],
      ['2026-11-08', 'Deepavali'],
      ['2026-12-25', 'Christmas Day']
    ];

    for (const [d, n] of holidays) {
      await client.query(`
        INSERT INTO public_holidays (holiday_date, name)
        VALUES ($1, $2)
        ON CONFLICT (holiday_date) DO NOTHING;
      `, [d, n]);
    }

    // 5. Create payroll_reports table
    await client.query(`
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
    `);

    // Backfill existing approved checkins into daily_attendance so history is preserved
    await client.query(`
      INSERT INTO daily_attendance (site_id, worker_id, attendance_date, status, in_time, out_time, remarks, source)
      SELECT DISTINCT ON (ci.site_id, ci.cleaner_id, (ci.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
        ci.site_id,
        ci.cleaner_id AS worker_id,
        (ci.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS attendance_date,
        'Present' AS status,
        TO_CHAR(ci.created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'HH24:MI') AS in_time,
        NULL AS out_time,
        COALESCE(ci.remark, 'Verified via PIC WhatsApp approval') AS remarks,
        'pic_phone' AS source
      FROM checkins ci
      WHERE ci.status = 'approved' AND ci.action_type = 'time_in'
      ORDER BY ci.site_id, ci.cleaner_id, (ci.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date, ci.created_at ASC
      ON CONFLICT (site_id, worker_id, attendance_date) DO UPDATE
      SET in_time = EXCLUDED.in_time,
          status = 'Present',
          remarks = COALESCE(daily_attendance.remarks, EXCLUDED.remarks);
    `);

    await client.query('COMMIT');
    console.log('Migration completed successfully!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = { migrate };
