const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { distanceMeters, isWithinGeofence } = require('../geofence');
const { sendNotification } = require('../whatsapp');

const router = express.Router();

/**
 * POST /checkin
 * body: { employee_code, latitude, longitude, photo }
 *
 * Flow:
 *  1. Look up the cleaner and their assigned site.
 *  2. Verify photo is provided.
 *  3. Compute distance to the site and whether it's within the geofence.
 *  4. Create a checkin record (pending) with photo_data.
 *  5. If within geofence, notify the site's PIC via WhatsApp with the photo & approval link.
 */
router.post('/checkin', async (req, res) => {
  const { employee_code, latitude, longitude, photo } = req.body;
  const action_type = (req.body.action_type || req.body.type || 'time_in').toLowerCase() === 'time_out' ? 'time_out' : 'time_in';
  const typeText = action_type === 'time_out' ? 'Time Out' : 'Time In';
  const typeLabel = action_type === 'time_out' ? 'TIME OUT 🔴' : 'TIME IN 🟢';

  if (!employee_code || latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'employee_code, latitude, longitude are required' });
  }

  if (!photo) {
    return res.status(400).json({ error: 'Live photo is required to prevent clocking in for others.' });
  }

  const lat = Number(latitude);
  const lon = Number(longitude);
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return res.status(400).json({ error: 'latitude/longitude must be numbers' });
  }

  let client;
  try {
    client = await pool.connect();
    const cleanerResult = await client.query(
      `SELECT c.id AS cleaner_id, c.name AS cleaner_name,
              s.id AS site_id, s.name AS site_name,
              s.latitude AS site_lat, s.longitude AS site_lon, s.radius_meters
       FROM cleaners c
       JOIN sites s ON s.id = c.site_id
       WHERE c.employee_code = $1`,
      [employee_code]
    );

    if (cleanerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Unknown employee_code' });
    }

    const cleaner = cleanerResult.rows[0];
    const dist = distanceMeters(lat, lon, cleaner.site_lat, cleaner.site_lon);
    const within = isWithinGeofence(dist, cleaner.radius_meters);
    const token = uuidv4();

    // Notify every PIC configured for this site.
    const picResult = await client.query(
      `SELECT id, name, whatsapp_number FROM pics WHERE site_id = $1 ORDER BY id`,
      [cleaner.site_id]
    );
    const pics = picResult.rows;

    const insertResult = await client.query(
      `INSERT INTO checkins
         (cleaner_id, site_id, latitude, longitude, distance_meters, within_geofence, status, approval_token, pic_id, photo_data, action_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10)
       RETURNING id, created_at`,
      [cleaner.cleaner_id, cleaner.site_id, lat, lon, dist, within, token, pics.length > 0 ? pics[0].id : null, photo, action_type]
    );

    const checkinId = insertResult.rows[0].id;

    if (!within) {
      return res.status(400).json({
        checkin_id: checkinId,
        action_type,
        status: 'pending',
        within_geofence: false,
        distance_meters: Math.round(dist),
        error: `${typeText} Failed: You are ${Math.round(dist)}m from ${cleaner.site_name}, outside the allowed ${cleaner.radius_meters}m range. Please move closer and retry.`,
      });
    }

    if (pics.length === 0) {
      return res.status(200).json({
        checkin_id: checkinId,
        action_type,
        status: 'pending',
        within_geofence: true,
        message: `${typeText} recorded, but no PIC is configured for this site yet — approval could not be requested.`,
      });
    }

    const approvalUrl = `${process.env.PUBLIC_BASE_URL}/approve.html?token=${token}`;
    const message =
      `Attendance approval needed [${typeLabel}]\n` +
      `Cleaner: ${cleaner.cleaner_name}\n` +
      `Action: ${typeText}\n` +
      `Site: ${cleaner.site_name}\n` +
      `Time: ${new Date().toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })}\n\n` +
      `Approve or reject here:\n${approvalUrl}\n\n` +
      `This link expires once used.`;

    let sentCount = 0;
    let firstError = null;

    for (const pic of pics) {
      try {
        await sendNotification(pic.whatsapp_number, message, photo);
        sentCount += 1;
      } catch (waErr) {
        firstError = waErr;
        console.error('Failed to send WhatsApp notification to PIC', pic.whatsapp_number, waErr);
      }
    }

    if (sentCount === 0) {
      return res.status(200).json({
        checkin_id: checkinId,
        action_type,
        status: 'pending',
        within_geofence: true,
        site_name: cleaner.site_name,
        cleaner_name: cleaner.cleaner_name,
        warning: `${typeText} recorded, but WhatsApp alert to PIC could not be sent (WhatsApp bot offline).`,
        message: `${typeText} at ${cleaner.site_name}! (Attendance saved in system).`,
        error: firstError ? String(firstError) : undefined,
      });
    }

    return res.status(200).json({
      checkin_id: checkinId,
      action_type,
      status: 'pending',
      within_geofence: true,
      distance_meters: Math.round(dist),
      sent_to_pics: sentCount,
      site_name: cleaner.site_name,
      cleaner_name: cleaner.cleaner_name,
      message: `${typeText} at ${cleaner.site_name}! Sent to PIC for approval.`,
    });
  } catch (err) {
    console.error('Error in /checkin', err);
    const isDbConnError = err.code === 'ECONNREFUSED' || !process.env.DATABASE_URL;
    return res.status(500).json({
      error: isDbConnError
        ? 'Database connection failed. Please configure DATABASE_URL in Render environment variables.'
        : 'Internal server error: ' + err.message,
    });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
