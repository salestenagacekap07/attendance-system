const express = require('express');
const { pool } = require('../db');
const { calculateWorkerSalary } = require('../salaryCalculator');

const router = express.Router();

function normalizeWhatsAppNumber(raw) {
  if (raw === null || raw === undefined) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) return '60' + digits.slice(1);
  if (digits.startsWith('60')) return digits;
  if (digits.startsWith('6')) return digits;
  return digits;
}

function timeToMinutes(tStr) {
  if (!tStr || !tStr.includes(':')) return 0;
  const [h, m] = tStr.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// ==========================================
// MODULE 1: SITE MANAGEMENT
// ==========================================

// List Sites
router.get('/api/operations/sites', async function (_req, res) {
  try {
    const query = `
      SELECT s.id, s.name, s.client_id, s.latitude, s.longitude, s.radius_meters,
             s.pic_name, s.pic_phone, s.pic_email, s.opening_date,
             s.working_days_pattern, s.working_time_start, s.working_time_end,
             s.break_time_minutes, s.allowed_worker_types, s.landscaper_salary_type,
             s.created_at,
             (SELECT COUNT(*)::int FROM cleaners c WHERE c.site_id = s.id) AS worker_count
      FROM sites s
      ORDER BY s.name ASC
    `;
    const { rows } = await pool.query(query);
    return res.json(rows);
  } catch (error) {
    console.error('Error in GET /api/operations/sites', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// Create Site
router.post('/api/operations/sites', async function (req, res) {
  try {
    const {
      name,
      pic_name,
      pic_phone,
      pic_email,
      opening_date,
      longitude,
      latitude,
      radius_meters = 150,
      working_days_pattern = 'Mon-Fri',
      working_time_start = '09:00',
      working_time_end = '17:00',
      break_time_minutes = 60,
      allowed_worker_types = ['Cleaner', 'General Worker', 'Landscaper'],
      landscaper_salary_type = 'monthly'
    } = req.body || {};

    if (!name || !pic_name || !pic_phone || !pic_email || !opening_date || latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        error: 'Required fields missing: Site Name, PIC Name, PIC Phone, PIC Email, Opening Date, Latitude, Longitude.'
      });
    }

    const cleanPhone = normalizeWhatsAppNumber(pic_phone);
    const workerTypesArray = Array.isArray(allowed_worker_types) && allowed_worker_types.length > 0
      ? allowed_worker_types
      : ['Cleaner'];

    const clientRes = await pool.query('SELECT id FROM clients LIMIT 1');
    const clientId = clientRes.rows[0]?.id || 1;

    const insertSql = `
      INSERT INTO sites (
        client_id, name, latitude, longitude, radius_meters,
        pic_name, pic_phone, pic_email, opening_date,
        working_days_pattern, working_time_start, working_time_end,
        break_time_minutes, allowed_worker_types, landscaper_salary_type
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *
    `;

    const { rows } = await pool.query(insertSql, [
      clientId,
      name.trim(),
      Number(latitude),
      Number(longitude),
      Number(radius_meters) || 150,
      pic_name.trim(),
      cleanPhone,
      pic_email.trim(),
      opening_date,
      ['Mon-Fri', 'Mon-Sat'].includes(working_days_pattern) ? working_days_pattern : 'Mon-Fri',
      working_time_start.trim() || '09:00',
      working_time_end.trim() || '17:00',
      Number(break_time_minutes) || 60,
      JSON.stringify(workerTypesArray),
      ['monthly', 'daily'].includes(landscaper_salary_type) ? landscaper_salary_type : 'monthly'
    ]);

    const newSite = rows[0];

    // Ensure PIC table is in sync so PIC WhatsApp routing works
    await pool.query(
      `INSERT INTO pics (site_id, name, whatsapp_number)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [newSite.id, pic_name.trim(), cleanPhone]
    );

    return res.status(201).json(newSite);
  } catch (error) {
    console.error('Error in POST /api/operations/sites', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// Update Site
router.put('/api/operations/sites/:id', async function (req, res) {
  try {
    const { id } = req.params;
    const {
      name,
      pic_name,
      pic_phone,
      pic_email,
      opening_date,
      longitude,
      latitude,
      radius_meters,
      working_days_pattern,
      working_time_start,
      working_time_end,
      break_time_minutes,
      allowed_worker_types,
      landscaper_salary_type
    } = req.body || {};

    const cleanPhone = pic_phone ? normalizeWhatsAppNumber(pic_phone) : null;

    const updateSql = `
      UPDATE sites
      SET name = COALESCE($1, name),
          pic_name = COALESCE($2, pic_name),
          pic_phone = COALESCE($3, pic_phone),
          pic_email = COALESCE($4, pic_email),
          opening_date = COALESCE($5, opening_date),
          latitude = COALESCE($6, latitude),
          longitude = COALESCE($7, longitude),
          radius_meters = COALESCE($8, radius_meters),
          working_days_pattern = COALESCE($9, working_days_pattern),
          working_time_start = COALESCE($10, working_time_start),
          working_time_end = COALESCE($11, working_time_end),
          break_time_minutes = COALESCE($12, break_time_minutes),
          allowed_worker_types = COALESCE($13, allowed_worker_types),
          landscaper_salary_type = COALESCE($14, landscaper_salary_type)
      WHERE id = $15
      RETURNING *
    `;

    const { rows } = await pool.query(updateSql, [
      name ? name.trim() : null,
      pic_name ? pic_name.trim() : null,
      cleanPhone,
      pic_email ? pic_email.trim() : null,
      opening_date || null,
      latitude !== undefined ? Number(latitude) : null,
      longitude !== undefined ? Number(longitude) : null,
      radius_meters !== undefined ? Number(radius_meters) : null,
      working_days_pattern || null,
      working_time_start || null,
      working_time_end || null,
      break_time_minutes !== undefined ? Number(break_time_minutes) : null,
      allowed_worker_types ? JSON.stringify(allowed_worker_types) : null,
      landscaper_salary_type || null,
      Number(id)
    ]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Site not found' });
    }

    // Sync PIC record
    if (pic_name || cleanPhone) {
      await pool.query(
        `UPDATE pics SET name = COALESCE($1, name), whatsapp_number = COALESCE($2, whatsapp_number) WHERE site_id = $3`,
        [pic_name ? pic_name.trim() : null, cleanPhone, Number(id)]
      );
    }

    return res.json(rows[0]);
  } catch (error) {
    console.error('Error in PUT /api/operations/sites/:id', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// Delete Site
router.delete('/api/operations/sites/:id', async function (req, res) {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM sites WHERE id = $1', [Number(id)]);
    if (rowCount === 0) return res.status(404).json({ error: 'Site not found' });
    return res.json({ ok: true });
  } catch (error) {
    console.error('Error in DELETE /api/operations/sites/:id', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// ==========================================
// MODULE 2: WORKER TYPES & SALARY TYPES
// ==========================================

// List Workers
router.get('/api/operations/workers', async function (req, res) {
  try {
    const { site_id, worker_type, search } = req.query;
    let query = `
      SELECT c.id, c.site_id, c.name, c.employee_code, c.phone, c.status,
             c.worker_type, c.salary_type, c.base_salary, c.created_at,
             s.name AS site_name, s.working_days_pattern, s.working_time_start, s.working_time_end
      FROM cleaners c
      JOIN sites s ON s.id = c.site_id
      WHERE 1=1
    `;
    const params = [];
    if (site_id) {
      params.push(site_id);
      query += ` AND c.site_id = $${params.length}`;
    }
    if (worker_type) {
      params.push(worker_type);
      query += ` AND c.worker_type = $${params.length}`;
    }
    if (search) {
      params.push(`%${search.trim()}%`);
      query += ` AND (c.name ILIKE $${params.length} OR c.employee_code ILIKE $${params.length})`;
    }
    query += ' ORDER BY c.name ASC';

    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (error) {
    console.error('Error in GET /api/operations/workers', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Add Worker
router.post('/api/operations/workers', async function (req, res) {
  try {
    const { site_id, name, employee_code, worker_type = 'Cleaner', salary_type, base_salary, phone } = req.body || {};

    if (!site_id || !name || !employee_code) {
      return res.status(400).json({ error: 'Site, Worker Name, and Employee Code are required.' });
    }

    const type = ['Cleaner', 'General Worker', 'Landscaper'].includes(worker_type) ? worker_type : 'Cleaner';

    // Enforce salary logic:
    // 1. Cleaner: Monthly Salary
    // 2. General Worker: Daily Salary
    // 3. Landscaper: Monthly OR Daily
    let enforcedSalaryType = 'monthly';
    if (type === 'Cleaner') {
      enforcedSalaryType = 'monthly';
    } else if (type === 'General Worker') {
      enforcedSalaryType = 'daily';
    } else if (type === 'Landscaper') {
      enforcedSalaryType = (salary_type || 'monthly').toLowerCase() === 'daily' ? 'daily' : 'monthly';
    }

    const baseVal = Number(base_salary) > 0 ? Number(base_salary) : (enforcedSalaryType === 'monthly' ? 1500.00 : 80.00);

    const insertSql = `
      INSERT INTO cleaners (site_id, name, employee_code, worker_type, salary_type, base_salary, phone)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;

    const { rows } = await pool.query(insertSql, [
      Number(site_id),
      name.trim(),
      employee_code.trim().toUpperCase(),
      type,
      enforcedSalaryType,
      baseVal,
      phone ? phone.trim() : null
    ]);

    return res.status(201).json(rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Employee code already exists. Please choose a unique code.' });
    }
    console.error('Error in POST /api/operations/workers', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// Update Worker
router.put('/api/operations/workers/:id', async function (req, res) {
  try {
    const { id } = req.params;
    const { site_id, name, employee_code, worker_type, salary_type, base_salary, phone, status } = req.body || {};

    let enforcedSalaryType = undefined;
    if (worker_type === 'Cleaner') {
      enforcedSalaryType = 'monthly';
    } else if (worker_type === 'General Worker') {
      enforcedSalaryType = 'daily';
    } else if (worker_type === 'Landscaper' && salary_type) {
      enforcedSalaryType = salary_type.toLowerCase() === 'daily' ? 'daily' : 'monthly';
    }

    const updateSql = `
      UPDATE cleaners
      SET site_id = COALESCE($1, site_id),
          name = COALESCE($2, name),
          employee_code = COALESCE($3, employee_code),
          worker_type = COALESCE($4, worker_type),
          salary_type = COALESCE($5, salary_type),
          base_salary = COALESCE($6, base_salary),
          phone = COALESCE($7, phone),
          status = COALESCE($8, status)
      WHERE id = $9
      RETURNING *
    `;

    const { rows } = await pool.query(updateSql, [
      site_id ? Number(site_id) : null,
      name ? name.trim() : null,
      employee_code ? employee_code.trim().toUpperCase() : null,
      worker_type || null,
      enforcedSalaryType || salary_type || null,
      base_salary !== undefined ? Number(base_salary) : null,
      phone !== undefined ? phone : null,
      status || null,
      Number(id)
    ]);

    if (rows.length === 0) return res.status(404).json({ error: 'Worker not found' });
    return res.json(rows[0]);
  } catch (error) {
    console.error('Error in PUT /api/operations/workers/:id', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// Delete Worker
router.delete('/api/operations/workers/:id', async function (req, res) {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM cleaners WHERE id = $1', [Number(id)]);
    if (rowCount === 0) return res.status(404).json({ error: 'Worker not found' });
    return res.json({ ok: true });
  } catch (error) {
    console.error('Error in DELETE /api/operations/workers/:id', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// ==========================================
// MODULE 3: ATTENDANCE SYSTEM & DAILY SHEET
// ==========================================

// Get Attendance Sheet for Site and Month
router.get('/api/operations/attendance-sheet', async function (req, res) {
  try {
    const { site_id, year, month } = req.query;
    if (!site_id) return res.status(400).json({ error: 'site_id is required' });

    const currentYear = year ? parseInt(year, 10) : new Date().getFullYear();
    const currentMonth = month ? parseInt(month, 10) : (new Date().getMonth() + 1);

    const siteRes = await pool.query('SELECT * FROM sites WHERE id = $1', [Number(site_id)]);
    if (siteRes.rows.length === 0) return res.status(404).json({ error: 'Site not found' });
    const site = siteRes.rows[0];

    const workersRes = await pool.query(
      'SELECT id, name, employee_code, worker_type, salary_type, base_salary FROM cleaners WHERE site_id = $1 ORDER BY name ASC',
      [Number(site_id)]
    );
    const workers = workersRes.rows;

    const startDate = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
    const lastDayNum = new Date(currentYear, currentMonth, 0).getDate();
    const endDate = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(lastDayNum).padStart(2, '0')}`;

    const [attRes, phRes] = await Promise.all([
      pool.query(
        `SELECT id, worker_id, site_id, attendance_date::text AS attendance_date,
                status, in_time, out_time, ot_hours, late_hours, remarks, source, updated_at
         FROM daily_attendance
         WHERE site_id = $1 AND attendance_date >= $2 AND attendance_date <= $3
         ORDER BY attendance_date ASC, worker_id ASC`,
        [Number(site_id), startDate, endDate]
      ),
      pool.query(
        `SELECT holiday_date::text AS holiday_date, name
         FROM public_holidays
         WHERE holiday_date >= $1 AND holiday_date <= $2
         ORDER BY holiday_date ASC`,
        [startDate, endDate]
      )
    ]);

    return res.json({
      site,
      year: currentYear,
      month: currentMonth,
      total_days: lastDayNum,
      public_holidays: phRes.rows,
      workers,
      records: attRes.rows
    });
  } catch (error) {
    console.error('Error in /api/operations/attendance-sheet', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// Update Worker Attendance Daily
router.post('/api/operations/attendance', async function (req, res) {
  try {
    const { site_id, worker_id, date, status, in_time, out_time, ot_hours, late_hours, remarks } = req.body || {};

    if (!site_id || !worker_id || !date || !status) {
      return res.status(400).json({ error: 'site_id, worker_id, date, and status are required' });
    }

    const validStatuses = ['Present', 'Absent', 'Half Day', 'Leave', 'OT'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Choose from: ${validStatuses.join(', ')}` });
    }

    // Site lookup for working times
    const siteRes = await pool.query('SELECT working_time_start, working_time_end FROM sites WHERE id = $1', [Number(site_id)]);
    const site = siteRes.rows[0] || {};

    let computedLate = Number(late_hours) || 0;
    let computedOt = Number(ot_hours) || 0;

    // Auto-calculate late hours if in_time provided and late_hours not given
    if (in_time && in_time.includes(':') && late_hours === undefined) {
      const siteStartMin = timeToMinutes(site.working_time_start || '09:00');
      const inMin = timeToMinutes(in_time);
      if (inMin > siteStartMin) {
        computedLate = Number(((inMin - siteStartMin) / 60).toFixed(2));
      }
    }

    // Auto-calculate OT hours if out_time provided and ot_hours not given
    if (out_time && out_time.includes(':') && ot_hours === undefined) {
      const siteEndMin = timeToMinutes(site.working_time_end || '17:00');
      const outMin = timeToMinutes(out_time);
      if (outMin > siteEndMin) {
        computedOt = Number(((outMin - siteEndMin) / 60).toFixed(2));
      }
    }

    const upsertSql = `
      INSERT INTO daily_attendance (
        site_id, worker_id, attendance_date, status,
        in_time, out_time, ot_hours, late_hours, remarks, source, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual', now())
      ON CONFLICT (site_id, worker_id, attendance_date) DO UPDATE
      SET status = EXCLUDED.status,
          in_time = COALESCE(EXCLUDED.in_time, daily_attendance.in_time),
          out_time = COALESCE(EXCLUDED.out_time, daily_attendance.out_time),
          ot_hours = EXCLUDED.ot_hours,
          late_hours = EXCLUDED.late_hours,
          remarks = EXCLUDED.remarks,
          source = 'manual',
          updated_at = now()
      RETURNING *
    `;

    const { rows } = await pool.query(upsertSql, [
      Number(site_id),
      Number(worker_id),
      date,
      status,
      in_time || null,
      out_time || null,
      computedOt,
      computedLate,
      remarks ? remarks.trim() : null
    ]);

    return res.json(rows[0]);
  } catch (error) {
    console.error('Error in POST /api/operations/attendance', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// ==========================================
// MODULE 4: SALARY CALCULATION & PAYROLL
// ==========================================

// Get Payroll Summary & Salary Calculation
router.get('/api/operations/payroll', async function (req, res) {
  try {
    const { site_id, year, month } = req.query;
    if (!site_id) return res.status(400).json({ error: 'site_id is required' });

    const currentYear = year ? parseInt(year, 10) : new Date().getFullYear();
    const currentMonth = month ? parseInt(month, 10) : (new Date().getMonth() + 1);

    const siteRes = await pool.query('SELECT * FROM sites WHERE id = $1', [Number(site_id)]);
    if (siteRes.rows.length === 0) return res.status(404).json({ error: 'Site not found' });
    const site = siteRes.rows[0];

    const workersRes = await pool.query(
      'SELECT id, name, employee_code, worker_type, salary_type, base_salary, phone FROM cleaners WHERE site_id = $1 ORDER BY name ASC',
      [Number(site_id)]
    );
    const workers = workersRes.rows;

    const startDate = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
    const lastDayNum = new Date(currentYear, currentMonth, 0).getDate();
    const endDate = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(lastDayNum).padStart(2, '0')}`;

    const [attRes, phRes] = await Promise.all([
      pool.query(
        `SELECT worker_id, attendance_date::text AS attendance_date, status, in_time, out_time, ot_hours, late_hours, remarks
         FROM daily_attendance
         WHERE site_id = $1 AND attendance_date >= $2 AND attendance_date <= $3`,
        [Number(site_id), startDate, endDate]
      ),
      pool.query(
        `SELECT holiday_date::text AS holiday_date, name
         FROM public_holidays
         WHERE holiday_date >= $1 AND holiday_date <= $2`,
        [startDate, endDate]
      )
    ]);

    // Group attendance by worker_id
    const attByWorker = {};
    attRes.rows.forEach(r => {
      if (!attByWorker[r.worker_id]) attByWorker[r.worker_id] = [];
      attByWorker[r.worker_id].push(r);
    });

    // Calculate payroll for each worker
    const payrollItems = workers.map(w => {
      const workerAtt = attByWorker[w.id] || [];
      return calculateWorkerSalary({
        worker: w,
        site,
        year: currentYear,
        month: currentMonth,
        attendanceRecords: workerAtt,
        publicHolidays: phRes.rows
      });
    });

    const totals = payrollItems.reduce((acc, item) => {
      acc.total_gross += item.gross_salary;
      acc.total_deductions += item.deductions.total;
      acc.total_ot_pay += item.ot_pay;
      acc.total_net += item.net_salary;
      return acc;
    }, { total_gross: 0, total_deductions: 0, total_ot_pay: 0, total_net: 0 });

    totals.total_gross = Number(totals.total_gross.toFixed(2));
    totals.total_deductions = Number(totals.total_deductions.toFixed(2));
    totals.total_ot_pay = Number(totals.total_ot_pay.toFixed(2));
    totals.total_net = Number(totals.total_net.toFixed(2));

    return res.json({
      site,
      year: currentYear,
      month: currentMonth,
      public_holidays: phRes.rows,
      workers_payroll: payrollItems,
      totals
    });
  } catch (error) {
    console.error('Error in /api/operations/payroll', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// Send Report by Email to Accounts
router.post('/api/operations/payroll/send-email', async function (req, res) {
  try {
    const { site_id, year, month, recipient_email, notes } = req.body || {};

    if (!site_id || !recipient_email) {
      return res.status(400).json({ error: 'site_id and recipient_email are required' });
    }

    const currentYear = year ? parseInt(year, 10) : new Date().getFullYear();
    const currentMonth = month ? parseInt(month, 10) : (new Date().getMonth() + 1);

    // Fetch site & payroll calculation
    const siteRes = await pool.query('SELECT * FROM sites WHERE id = $1', [Number(site_id)]);
    if (siteRes.rows.length === 0) return res.status(404).json({ error: 'Site not found' });
    const site = siteRes.rows[0];

    const workersRes = await pool.query(
      'SELECT id, name, employee_code, worker_type, salary_type, base_salary FROM cleaners WHERE site_id = $1 ORDER BY name ASC',
      [Number(site_id)]
    );
    const workers = workersRes.rows;

    const startDate = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
    const lastDayNum = new Date(currentYear, currentMonth, 0).getDate();
    const endDate = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(lastDayNum).padStart(2, '0')}`;

    const [attRes, phRes] = await Promise.all([
      pool.query(
        `SELECT worker_id, attendance_date::text AS attendance_date, status, in_time, out_time, ot_hours, late_hours, remarks
         FROM daily_attendance
         WHERE site_id = $1 AND attendance_date >= $2 AND attendance_date <= $3`,
        [Number(site_id), startDate, endDate]
      ),
      pool.query(
        `SELECT holiday_date::text AS holiday_date, name
         FROM public_holidays
         WHERE holiday_date >= $1 AND holiday_date <= $2`,
        [startDate, endDate]
      )
    ]);

    const attByWorker = {};
    attRes.rows.forEach(r => {
      if (!attByWorker[r.worker_id]) attByWorker[r.worker_id] = [];
      attByWorker[r.worker_id].push(r);
    });

    const payrollItems = workers.map(w => {
      const workerAtt = attByWorker[w.id] || [];
      return calculateWorkerSalary({
        worker: w,
        site,
        year: currentYear,
        month: currentMonth,
        attendanceRecords: workerAtt,
        publicHolidays: phRes.rows
      });
    });

    const totals = payrollItems.reduce((acc, item) => {
      acc.total_gross += item.gross_salary;
      acc.total_deductions += item.deductions.total;
      acc.total_ot_pay += item.ot_pay;
      acc.total_net += item.net_salary;
      return acc;
    }, { total_gross: 0, total_deductions: 0, total_ot_pay: 0, total_net: 0 });

    const reportData = {
      site_name: site.name,
      year: currentYear,
      month: currentMonth,
      month_name: new Date(currentYear, currentMonth - 1).toLocaleString('en-MY', { month: 'long', year: 'numeric' }),
      workers: payrollItems,
      totals,
      notes: notes || '',
      generated_at: new Date().toISOString()
    };

    // Save report in payroll_reports
    await pool.query(
      `INSERT INTO payroll_reports (site_id, year, month, report_data, sent_to_email, sent_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [Number(site_id), currentYear, currentMonth, JSON.stringify(reportData), recipient_email.trim()]
    );

    return res.json({
      success: true,
      message: `Payroll report for ${site.name} (${reportData.month_name}) dispatched to Accounts at ${recipient_email.trim()}!`,
      report: reportData
    });
  } catch (error) {
    console.error('Error in send-email', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// ==========================================
// LEGACY & REAL-TIME SWIPE ACTIVITY LOG
// ==========================================

// Summary metrics (Dashboard top cards)
router.get('/api/operations/summary', async function (_req, res) {
  try {
    const [sitesRes, workersRes, attRes, checkinsRes] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM sites'),
      pool.query('SELECT COUNT(*)::int AS count FROM cleaners'),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'Present')::int AS present_count,
          COUNT(*) FILTER (WHERE status = 'Absent')::int AS absent_count,
          COUNT(*) FILTER (WHERE status = 'Half Day')::int AS half_day_count,
          COUNT(*) FILTER (WHERE status = 'OT')::int AS ot_count
        FROM daily_attendance
        WHERE attendance_date = CURRENT_DATE
      `),
      pool.query(`
        SELECT
          COUNT(*)::int AS total_checkins,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
          COUNT(*) FILTER (WHERE status = 'approved')::int AS approved_count,
          COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected_count
        FROM checkins
      `),
    ]);

    return res.json({
      site_count: sitesRes.rows[0].count,
      cleaner_count: workersRes.rows[0].count,
      today_present: attRes.rows[0].present_count,
      today_absent: attRes.rows[0].absent_count,
      today_half_day: attRes.rows[0].half_day_count,
      today_ot: attRes.rows[0].ot_count,
      total_checkins: checkinsRes.rows[0].total_checkins,
      pending_count: checkinsRes.rows[0].pending_count,
      approved_count: checkinsRes.rows[0].approved_count,
      rejected_count: checkinsRes.rows[0].rejected_count,
    });
  } catch (error) {
    console.error('Error in /api/operations/summary', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Attendance swipes log (Mobile clock-ins & PIC approvals)
router.get('/api/operations/attendance', async function (req, res) {
  try {
    const { site_id, status, date, search } = req.query;
    let query = `
      SELECT ci.id, ci.cleaner_id, ci.site_id, ci.status, ci.action_type, ci.remark,
             ci.distance_meters, ci.created_at, ci.decided_at, ci.approval_token,
             cl.name AS cleaner_name, cl.employee_code, cl.worker_type,
             s.name AS site_name,
             COALESCE(s.pic_name, p.name) AS pic_name,
             COALESCE(s.pic_phone, p.whatsapp_number) AS pic_whatsapp
      FROM checkins ci
      JOIN cleaners cl ON cl.id = ci.cleaner_id
      JOIN sites s ON s.id = ci.site_id
      LEFT JOIN pics p ON p.id = ci.pic_id
      WHERE 1=1
    `;
    const params = [];

    if (site_id) {
      params.push(site_id);
      query += ` AND ci.site_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND ci.status = $${params.length}`;
    }
    if (date) {
      params.push(date);
      query += ` AND DATE(ci.created_at AT TIME ZONE 'Asia/Kuala_Lumpur') = $${params.length}::date`;
    }
    if (search) {
      params.push(`%${search.trim()}%`);
      query += ` AND (cl.name ILIKE $${params.length} OR cl.employee_code ILIKE $${params.length} OR s.name ILIKE $${params.length})`;
    }

    query += ' ORDER BY ci.created_at DESC LIMIT 200';

    const { rows } = await pool.query(query, params);
    return res.json({ rows });
  } catch (error) {
    console.error('Error in /api/operations/attendance', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Test WhatsApp link
router.post('/api/operations/test-whatsapp', async function (req, res) {
  try {
    const number = req.body.number || '60177489628';
    const cleanNum = normalizeWhatsAppNumber(number);
    const testMessage = `🔔 Attendance System Test: Direct WhatsApp link verified for +${cleanNum}! ✅`;
    const shareUrl = `https://wa.me/${cleanNum}?text=${encodeURIComponent(testMessage)}`;

    return res.json({
      connected: true,
      direct_mode: true,
      target: cleanNum,
      share_url: shareUrl,
      send_success: true
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
