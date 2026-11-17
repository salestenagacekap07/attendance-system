require('dotenv').config();
const path = require('path');
const express = require('express');

const { connectWhatsApp } = require('./whatsapp');
const checkinRouter = require('./routes/checkin');
const approveRouter = require('./routes/approve');
const operationsRouter = require('./routes/operations');
const pairRouter = require('./routes/pair');

const app = express();
app.use(express.json());

// Serve the static frontend (checkin.html, approve.html, pair.html) directly from Express
// so you don't need a separate web server for this MVP.
app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

app.use(checkinRouter);
app.use(approveRouter);
app.use(operationsRouter);
app.use(pairRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;

async function start() {
  await connectWhatsApp(); // prints a QR code to this terminal on first run
  app.listen(PORT, () => {
    console.log(`Attendance backend listening on http://localhost:${PORT}`);
    console.log(`Clock-in page:  http://localhost:${PORT}/checkin.html`);
  });
}

start().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
