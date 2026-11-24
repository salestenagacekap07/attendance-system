const express = require('express');
const router = express.Router();

router.get('/pair', (_req, res) => {
  res.redirect('/operations.html');
});

// Uptime keep-alive & health check endpoint (pings Render every 8 minutes)
router.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    gateway: 'direct-whatsapp'
  });
});

router.get('/api/pair/status', (_req, res) => {
  res.json({
    connected: true,
    direct_mode: true,
    message: 'Active with 1-Tap Direct WhatsApp Gateway'
  });
});

router.post('/api/pair', async (_req, res) => {
  res.json({
    success: true,
    direct_mode: true,
    message: 'System uses 1-Tap WhatsApp verification. Companion bot pairing is deprecated.'
  });
});

router.post('/api/pair/reset', async (_req, res) => {
  res.json({
    success: true,
    message: 'Direct WhatsApp configuration active.'
  });
});

module.exports = router;
