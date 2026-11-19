const express = require('express');
const { pool } = require('../db');

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

// 1. Clients
router.get('/api/operations/clients', async function (_req, res) {
  try {
    const { rows } = await pool.query('SELECT id, name FROM clients ORDER BY name ASC');
    return res.json(rows);
  } catch (error) {
    console.error('Error in /api/operations/clients', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Sites
router.get('/api/operations/sites', async function (req, res) {
  try {
    const { client_id } = req.query;
    let query = 'SELECT s.id, s.name, s.client_id, s.radius_meters, c.name AS client_name FROM sites s LEFT JOIN clients c ON c.id = s.client_id';
    const params = [];
    if (client_id) {
      query += ' WHERE s.client_id = $1';
      params.push(client_id);
    }
    query += ' ORDER BY s.name ASC';
    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (error) {
    console.error('Error in /api/operations/sites', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. PICs
router.get('/api/operations/pics', async function (req, res) {
  try {
    const { client_id, site_id } = req.query;
    let query = `
      SELECT p.id, p.site_id, p.name, p.whatsapp_number,
             s.name AS site_name, s.client_id,
             c.name AS client_name
      FROM pics p
      JOIN sites s ON s.id = p.site_id
      LEFT JOIN clients c ON c.id = s.client_id
      WHERE 1=1
    `;
    const params = [];
    if (client_id) {
      params.push(client_id);
      query += ` AND s.client_id = $${params.length}`;
    }
    if (site_id) {
      params.push(site_id);
      query += ` AND p.site_id = $${params.length}`;
    }
    query += ' ORDER BY p.id ASC';
    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (error) {
    console.error('Error in /api/operations/pics', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/api/operations/pics', async function (req, res) {
  try {
    const { site_id, name, whatsapp_number } = req.body || {};

    if (!site_id || !name || !whatsapp_number) {
      return res.status(400).json({ error: 'site_id, name, and whatsapp_number are required' });
    }

    const normalized = normalizeWhatsAppNumber(whatsapp_number);
    if (!normalized) {
      return res.status(400).json({ error: 'whatsapp_number is invalid' });
    }

    const { rows } = await pool.query(
      `INSERT INTO pics (site_id, name, whatsapp_number) VALUES ($1, $2, $3) RETURNING *`,
      [Number(site_id), name.trim(), normalized]
    );
    return res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating PIC', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/api/operations/pics/:id', async function (req, res) {
  try {
    const { id } = req.params;
    const { name, whatsapp_number, site_id } = req.body || {};

    if (!name || !whatsapp_number) {
      return res.status(400).json({ error: 'name and whatsapp_number are required' });
    }

    const normalized = normalizeWhatsAppNumber(whatsapp_number);
    if (!normalized) {
      return res.status(400).json({ error: 'whatsapp_number is invalid' });
    }

    const siteIdParam = site_id ? Number(site_id) : null;
    const { rows } = await pool.query(
      `UPDATE pics
       SET name = $1, whatsapp_number = $2, site_id = COALESCE($3, site_id)
       WHERE id = $4
       RETURNING *`,
      [name.trim(), normalized, siteIdParam, Number(id)]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'PIC not found' });
    }

    return res.json(rows[0]);
  } catch (error) {
    console.error('Error updating PIC', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/api/operations/pics/:id', async function (req, res) {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM pics WHERE id = $1', [Number(id)]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'PIC not found' });
    }
    return res.json({ ok: true });
  } catch (error) {
    console.error('Error deleting PIC', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. Summary metrics
router.get('/api/operations/summary', async function (req, res) {
  try {
    const [clientsRes, sitesRes, cleanersRes, checkinsRes] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM clients'),
      pool.query('SELECT COUNT(*)::int AS count FROM sites'),
      pool.query('SELECT COUNT(*)::int AS count FROM cleaners'),
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
      client_count: clientsRes.rows[0].count,
      site_count: sitesRes.rows[0].count,
      cleaner_count: cleanersRes.rows[0].count,
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

// 5. Attendance Records List (for Ops daily sheet)
router.get('/api/operations/attendance', async function (req, res) {
  try {
    const { client_id, site_id, status, date, search } = req.query;
    let query = `
      SELECT ci.id, ci.cleaner_id, ci.site_id, ci.status, ci.action_type, ci.remark,
             ci.distance_meters, ci.created_at, ci.decided_at,
             cl.name AS cleaner_name, cl.employee_code,
             s.name AS site_name, s.client_id,
             c.name AS client_name,
             COALESCE(p.name, (SELECT name FROM pics WHERE site_id = s.id LIMIT 1)) AS pic_name,
             COALESCE(p.whatsapp_number, (SELECT whatsapp_number FROM pics WHERE site_id = s.id LIMIT 1)) AS pic_whatsapp
      FROM checkins ci
      JOIN cleaners cl ON cl.id = ci.cleaner_id
      JOIN sites s ON s.id = ci.site_id
      LEFT JOIN clients c ON c.id = s.client_id
      LEFT JOIN pics p ON p.id = ci.pic_id
      WHERE 1=1
    `;
    const params = [];

    if (client_id) {
      params.push(client_id);
      query += ` AND s.client_id = $${params.length}`;
    }
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

// 6. Test WhatsApp notification endpoint
router.post('/api/operations/test-whatsapp', async function (req, res) {
  try {
    const { getSocket, isReady } = require('../whatsapp');
    const sock = getSocket();
    if (!isReady() || !sock) {
      return res.status(400).json({ error: 'WhatsApp bot is not connected' });
    }
    const number = req.body.number || '60177489628';
    const cleanNum = number.replace(/\D/g, '');
    let onWhatsAppResult = null;
    try {
      onWhatsAppResult = await sock.onWhatsApp(cleanNum);
    } catch (e) {
      onWhatsAppResult = { error: e.message };
    }

    let sendResult = null;
    let sendError = null;
    try {
      const targetJid = (Array.isArray(onWhatsAppResult) && onWhatsAppResult[0]?.jid)
        ? onWhatsAppResult[0].jid
        : `${cleanNum}@s.whatsapp.net`;
      sendResult = await sock.sendMessage(targetJid, { text: 'Test alert from Attendance System: Connection active.' });
    } catch (err) {
      sendError = err.message;
    }

    return res.json({
      connected: isReady(),
      bot_user: sock.user,
      target: cleanNum,
      on_whatsapp: onWhatsAppResult,
      send_result: sendResult ? { id: sendResult.key?.id } : null,
      send_error: sendError
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
});

module.exports = router;
