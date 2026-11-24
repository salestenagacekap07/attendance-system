require('dotenv').config();
const path = require('path');
const express = require('express');

const checkinRouter = require('./routes/checkin');
const approveRouter = require('./routes/approve');
const operationsRouter = require('./routes/operations');
const pairRouter = require('./routes/pair');
const { migrate } = require('./migrate');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Never cache HTML/JS frontend assets so phones always fetch live updates
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Serve the static frontend (checkin.html, approve.html, pair.html) directly from Express
app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

app.use(checkinRouter);
app.use(approveRouter);
app.use(operationsRouter);
app.use(pairRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await migrate();
  } catch (err) {
    console.warn('Auto-migration warning on boot:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`Attendance backend listening on http://localhost:${PORT}`);
    console.log(`Clock-in page:  http://localhost:${PORT}/checkin.html`);

    // Self-ping keep-alive: ping the public URL every 8 minutes to prevent Render free-tier idle sleep
    const baseUrl = process.env.PUBLIC_BASE_URL;
    if (baseUrl && !baseUrl.includes('localhost')) {
      const healthUrl = `${baseUrl.replace(/\/$/, '')}/api/health`;
      console.log(`[Keep-Alive] Initializing self-ping monitor targeting: ${healthUrl} every 8 minutes`);
      // Initial ping after 30 seconds
      setTimeout(async () => {
        try {
          const res = await fetch(healthUrl);
          console.log(`[Keep-Alive] Initial ping to ${healthUrl} - Status: ${res.status}`);
        } catch (e) {
          console.warn(`[Keep-Alive] Initial ping warning:`, e.message);
        }
      }, 30000);

      // Periodic ping every 8 minutes
      setInterval(async () => {
        try {
          const res = await fetch(healthUrl);
          console.log(`[Keep-Alive] Pinged ${healthUrl} - Status: ${res.status}`);
        } catch (e) {
          console.warn(`[Keep-Alive] Ping warning:`, e.message);
        }
      }, 8 * 60 * 1000);
    }
  });
}

start().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
