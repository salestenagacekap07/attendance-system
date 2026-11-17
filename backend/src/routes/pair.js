const express = require('express');
const router = express.Router();
const { requestPairingCode, isReady } = require('../whatsapp');

router.get('/pair', (_req, res) => {
  res.redirect('/pair.html');
});

router.get('/api/pair/status', (_req, res) => {
  res.json({ connected: isReady() });
});

router.post('/api/pair', async (req, res) => {
  const { phoneNumber } = req.body || {};
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required.' });
  }

  try {
    const code = await requestPairingCode(phoneNumber);
    res.json({ success: true, code });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to request pairing code.' });
  }
});

module.exports = router;
