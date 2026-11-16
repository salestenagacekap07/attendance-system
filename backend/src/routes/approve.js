const express = require('express');
const { pool } = require('../db');
const { sendText } = require('../whatsapp');

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
      `SELECT ci.id, ci.status, ci.created_at, ci.distance_meters,
              cl.name AS cleaner_name, s.name AS site_name
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
  const { token, decision } = req.body;

  if (!token || !['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'token and decision ("approved"|"rejected") are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the row so a double-tap can't process twice.
    const current = await client.query(
      `SELECT ci.id, ci.status, ci.cleaner_id, cl.name AS cleaner_name
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

    if (checkin.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `This check-in was already ${checkin.status}.` });
    }

    const updated = await client.query(
      `UPDATE checkins
       SET status = $1, decided_at = now()
       WHERE id = $2
       RETURNING id, status, decided_at`,
      [decision, checkin.id]
    );

    await client.query('COMMIT');

    return res.json({
      checkin_id: updated.rows[0].id,
      status: updated.rows[0].status,
      cleaner_name: checkin.cleaner_name,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in /api/approve', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
