const express = require('express');
const db = require('../db');

const router = express.Router();

function normalizeWhatsAppNumber(raw) {
  if (raw === null || raw === undefined) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('0')) return '6' + digits.slice(1);
  if (digits.startsWith('60')) return digits;
  if (digits.startsWith('6')) return digits;
  return digits;
}

router.get('/api/operations/clients', async function (_req, res) {
  try {
    return res.json(db.listClients());
  } catch (error) {
    console.error('Error in /api/operations/clients', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/operations/sites', async function (req, res) {
  try {
    const { client_id } = req.query;
    return res.json(db.listSites(client_id || null));
  } catch (error) {
    console.error('Error in /api/operations/sites', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/operations/pics', async function (req, res) {
  try {
    const { client_id, site_id } = req.query;
    return res.json(db.listPics(client_id || null, site_id || null));
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

    const pic = db.createPic({ site_id, name, whatsapp_number: normalized });
    return res.status(201).json(pic);
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

    const updated = db.updatePic(id, { site_id, name, whatsapp_number: normalized });
    if (!updated) {
      return res.status(404).json({ error: 'PIC not found' });
    }

    return res.json(updated);
  } catch (error) {
    console.error('Error updating PIC', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/api/operations/pics/:id', async function (req, res) {
  try {
    const { id } = req.params;
    const ok = db.deletePic(id);
    if (!ok) {
      return res.status(404).json({ error: 'PIC not found' });
    }
    return res.json({ ok: true });
  } catch (error) {
    console.error('Error deleting PIC', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/operations/summary', async function (req, res) {
  try {
    return res.json(db.getSummary({
      client_id: req.query.client_id || null,
      site_id: req.query.site_id || null,
      status: req.query.status || null,
      date: req.query.date || null
    }));
  } catch (error) {
    console.error('Error in /api/operations/summary', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/operations/attendance', async function (req, res) {
  try {
    return res.json({
      rows: db.getAttendance({
        client_id: req.query.client_id || null,
        site_id: req.query.site_id || null,
        status: req.query.status || null,
        date: req.query.date || null,
        search: req.query.search || null
      })
    });
  } catch (error) {
    console.error('Error in /api/operations/attendance', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
