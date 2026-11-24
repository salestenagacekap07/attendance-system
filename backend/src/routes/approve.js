const express = require('express');
const { pool } = require('../db');

const router = express.Router();

/**
 * GET /api/checkin-info?token=...
 * Returns the checkin details for the approval page to render, without
 * revealing anything if the token is invalid/already used.
 */
router.get('/api/checkin-info', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'token is required' });

  try {
    const result = await pool.query(
      `SELECT ci.id, ci.status, ci.created_at, ci.distance_meters, ci.photo_data,
              ci.action_type, ci.remark, ci.device_id,
              cl.name AS cleaner_name, cl.employee_code, s.name AS site_name
       FROM checkins ci
       JOIN cleaners cl ON cl.id = ci.cleaner_id
       JOIN sites s ON s.id = ci.site_id
       WHERE ci.approval_token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired link' });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error in /api/checkin-info', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/approve
 * body: { token, decision: "approved" | "rejected" }
 *
 * Single-use: a token can only move a checkin out of "pending" once.
 */
router.post('/api/approve', async (req, res) => {
  const { token, decision, remark, client_device_id } = req.body;

  if (!token || !['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'token and decision ("approved"|"rejected") are required' });
  }

  const cleanRemark = typeof remark === 'string' && remark.trim().length > 0 ? remark.trim() : null;

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Lock the row so a double-tap can't process twice.
    const current = await client.query(
      `SELECT ci.id, ci.status, ci.cleaner_id, ci.site_id, ci.action_type, ci.device_id, ci.created_at, cl.name AS cleaner_name
       FROM checkins ci
       JOIN cleaners cl ON cl.id = ci.cleaner_id
       WHERE ci.approval_token = $1
       FOR UPDATE`,
      [token]
    );

    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invalid or expired link' });
    }

    const checkin = current.rows[0];

    // Anti-Self-Approval Security Guard:
    // If the approving device matches the device used to clock in, block it!
    const cleanClientDev = typeof client_device_id === 'string' ? client_device_id.trim() : null;
    if (cleanClientDev && checkin.device_id && cleanClientDev === checkin.device_id) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'Self-Approval Blocked: Cleaners are not permitted to approve their own attendance. Only the authorized PIC can approve from their phone.'
      });
    }

    if (checkin.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `This check-in was already ${checkin.status}.` });
    }

    const updated = await client.query(
      `UPDATE checkins
       SET status = $1, remark = $2, decided_at = now()
       WHERE id = $3
       RETURNING id, status, remark, decided_at`,
      [decision, cleanRemark, checkin.id]
    );

    // Sync PIC approval into OPS Daily Attendance Sheet
    try {
      const siteRes = await client.query(
        `SELECT working_time_start, working_time_end FROM sites WHERE id = $1`,
        [checkin.site_id]
      );
      const site = siteRes.rows[0] || {};
      const dateRes = await client.query(
        `SELECT (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS att_date,
                TO_CHAR(created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'HH24:MI') AS att_time
         FROM checkins WHERE id = $1`,
        [checkin.id]
      );
      const attDate = dateRes.rows[0]?.att_date;
      const attTime = dateRes.rows[0]?.att_time;

      if (attDate && attTime) {
        if (decision === 'approved') {
          const isOut = (checkin.action_type || '').toLowerCase() === 'time_out';
          if (isOut) {
            // Calculate OT hours if clocked out past site end time
            let otHours = 0;
            if (site.working_time_end && site.working_time_end.includes(':')) {
              const [eh, em] = site.working_time_end.split(':').map(Number);
              const [ah, am] = attTime.split(':').map(Number);
              const diffMin = (ah * 60 + am) - (eh * 60 + em);
              if (diffMin > 0) otHours = Number((diffMin / 60).toFixed(2));
            }
            await client.query(
              `INSERT INTO daily_attendance (site_id, worker_id, attendance_date, status, out_time, ot_hours, remarks, source)
               VALUES ($1, $2, $3, 'Present', $4, $5, $6, 'pic_phone')
               ON CONFLICT (site_id, worker_id, attendance_date) DO UPDATE
               SET out_time = EXCLUDED.out_time,
                   ot_hours = GREATEST(daily_attendance.ot_hours, EXCLUDED.ot_hours),
                   updated_at = now()`,
              [checkin.site_id, checkin.cleaner_id, attDate, attTime, otHours, cleanRemark || 'Approved by PIC']
            );
          } else {
            // Calculate Late hours if clocked in past site start time
            let lateHours = 0;
            if (site.working_time_start && site.working_time_start.includes(':')) {
              const [sh, sm] = site.working_time_start.split(':').map(Number);
              const [ah, am] = attTime.split(':').map(Number);
              const diffMin = (ah * 60 + am) - (sh * 60 + sm);
              if (diffMin > 0) lateHours = Number((diffMin / 60).toFixed(2));
            }
            await client.query(
              `INSERT INTO daily_attendance (site_id, worker_id, attendance_date, status, in_time, late_hours, remarks, source)
               VALUES ($1, $2, $3, 'Present', $4, $5, $6, 'pic_phone')
               ON CONFLICT (site_id, worker_id, attendance_date) DO UPDATE
               SET in_time = EXCLUDED.in_time,
                   late_hours = EXCLUDED.late_hours,
                   status = 'Present',
                   remarks = COALESCE(EXCLUDED.remarks, daily_attendance.remarks),
                   updated_at = now()`,
              [checkin.site_id, checkin.cleaner_id, attDate, attTime, lateHours, cleanRemark || 'Approved by PIC']
            );
          }
        } else if (decision === 'rejected') {
          await client.query(
            `INSERT INTO daily_attendance (site_id, worker_id, attendance_date, status, remarks, source)
             VALUES ($1, $2, $3, 'Absent', $4, 'pic_phone')
             ON CONFLICT (site_id, worker_id, attendance_date) DO UPDATE
             SET status = 'Absent',
                 remarks = COALESCE(EXCLUDED.remarks, daily_attendance.remarks),
                 updated_at = now()`,
            [checkin.site_id, checkin.cleaner_id, attDate, cleanRemark || 'Rejected by PIC']
          );
        }
      }
    } catch (syncErr) {
      console.error('Warning: Failed to sync PIC approval to daily_attendance:', syncErr);
    }

    await client.query('COMMIT');

    return res.json({
      checkin_id: updated.rows[0].id,
      status: updated.rows[0].status,
      cleaner_name: checkin.cleaner_name,
      remark: updated.rows[0].remark,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in /api/approve', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
