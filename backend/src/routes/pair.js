const express = require('express');
const router = express.Router();
const { requestPairingCode, isReady, getSocket, resetWhatsAppSession } = require('../whatsapp');

router.get('/pair', (_req, res) => {
  res.redirect('/pair.html');
});

router.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    whatsapp_connected: isReady()
  });
});

router.get('/api/pair/status', (_req, res) => {
  const ready = isReady();
  const sock = getSocket();
  let userPhone = null;
  let userName = null;
  if (ready && sock?.user) {
    userPhone = (sock.user.id || '').replace(/:.*$/, '');
    userName = sock.user.name || null;
  }
  res.json({
    connected: ready,
    phone: userPhone,
    name: userName
  });
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

router.post('/api/pair/reset', async (_req, res) => {
  try {
    await resetWhatsAppSession();
    res.json({ success: true, message: 'WhatsApp session reset. You can now request a new pairing code.' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to reset WhatsApp session.' });
  }
});

module.exports = router;
