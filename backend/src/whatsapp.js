/**
 * WhatsApp integration using Baileys (unofficial WhatsApp Web protocol).
 *
 * IMPORTANT — read this before relying on it for anything business-critical:
 * - This connects as a normal WhatsApp Web session on a real phone number,
 *   not Meta's official Business API. It is free, but automated use like
 *   this is outside WhatsApp's Terms of Service, and Meta can detect and
 *   ban numbers that send many automated messages. There is no way to make
 *   this fully "safe" from that risk — only lower it.
 * - To keep this looking as close to normal human usage as practical, we:
 *     1. Send plain text only (no buttons, no templates, no bulk blasts).
 *     2. Queue outgoing messages and send them one at a time with a small
 *        randomized delay, instead of firing them all at once.
 *     3. Reuse a single logged-in session (session files in ./auth) rather
 *        than reconnecting repeatedly.
 * - Have a fallback plan (e.g. SMS, a second number, or upgrading to the
 *   official Cloud API) in case this number ever gets banned or logged out.
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  BufferJSON,
  initAuthCreds,
  proto,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const path = require('path');
const pino = require('pino');
const { pool } = require('./db');

const AUTH_DIR = path.join(__dirname, '..', 'auth');

async function usePostgresAuthState(pgPool) {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const writeData = async (data, id) => {
    try {
      const serialized = JSON.stringify(data, BufferJSON.replacer);
      await pgPool.query(
        `INSERT INTO whatsapp_auth (id, value)
         VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
        [id, serialized]
      );
    } catch (err) {
      console.error(`Error writing auth data for ${id}:`, err.message);
    }
  };

  const readData = async (id) => {
    try {
      const res = await pgPool.query(`SELECT value FROM whatsapp_auth WHERE id = $1`, [id]);
      if (res.rows.length === 0) return null;
      return JSON.parse(res.rows[0].value, BufferJSON.reviver);
    } catch (err) {
      console.error(`Error reading auth data for ${id}:`, err.message);
      return null;
    }
  };

  const removeData = async (id) => {
    try {
      await pgPool.query(`DELETE FROM whatsapp_auth WHERE id = $1`, [id]);
    } catch (err) {
      console.error(`Error removing auth data for ${id}:`, err.message);
    }
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds'),
  };
}

let sock = null;
let isReady = false;

// Simple in-memory outgoing queue so messages are paced, not blasted.
const outgoingQueue = [];
let queueRunning = false;

function randomDelayMs(minMs = 1500, maxMs = 5000) {
  return Math.floor(Math.random() * (maxMs - minMs)) + minMs;
}

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;

  while (outgoingQueue.length > 0) {
    const { jid, text, image, resolve, reject } = outgoingQueue.shift();
    try {
      if (!isReady || !sock) {
        throw new Error('WhatsApp socket is not connected yet');
      }
      if (image) {
        try {
          let buffer;
          if (Buffer.isBuffer(image)) {
            buffer = image;
          } else if (typeof image === 'string') {
            const cleanBase64 = image.replace(/^data:image\/\w+;base64,/, '');
            buffer = Buffer.from(cleanBase64, 'base64');
          }
          await sock.sendMessage(jid, { image: buffer, caption: text });
          resolve(true);
        } catch (imgErr) {
          console.warn('Failed to send photo over WhatsApp, falling back to text:', imgErr.message);
          await sock.sendMessage(jid, { text });
          resolve(true);
        }
      } else {
        await sock.sendMessage(jid, { text });
        resolve(true);
      }
    } catch (err) {
      reject(err);
    }
    // Pace sends so this doesn't look like a bulk-blasting bot.
    await new Promise((r) => setTimeout(r, randomDelayMs()));
  }

  queueRunning = false;
}

/**
 * Queue a WhatsApp message with optional image to a phone number.
 * @param {string} phoneNumber - digits only, with country code, e.g. "60123456789"
 * @param {string} text
 * @param {string|Buffer|null} image - optional base64 string or Buffer
 */
function sendNotification(phoneNumber, text, image = null) {
  const jid = `${phoneNumber.replace(/[^\d]/g, '')}@s.whatsapp.net`;
  return new Promise((resolve, reject) => {
    outgoingQueue.push({ jid, text, image, resolve, reject });
    processQueue();
  });
}

function sendText(phoneNumber, text) {
  return sendNotification(phoneNumber, text, null);
}

function cleanPhoneNumber(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('0')) {
    digits = '60' + digits.slice(1);
  }
  return digits;
}

/**
 * Request an 8-character WhatsApp pairing code for a phone number.
 * @param {string} rawNumber - phone number (e.g. "60123456789" or "0123456789")
 * @returns {Promise<string>} 8-character pairing code
 */
async function requestPairingCode(rawNumber) {
  if (!sock) {
    throw new Error('WhatsApp client is initializing. Please wait a few seconds and try again.');
  }
  if (isReady || sock.authState?.creds?.registered) {
    throw new Error('WhatsApp is already registered and connected.');
  }
  const cleanNumber = cleanPhoneNumber(rawNumber);
  if (!cleanNumber || cleanNumber.length < 8) {
    throw new Error('Please enter a valid phone number with country code (e.g. 60123456789).');
  }

  const code = await sock.requestPairingCode(cleanNumber);
  console.log('\n=========================================');
  console.log(`WhatsApp Pairing Code for ${cleanNumber}: ${code}`);
  console.log('Enter this code in WhatsApp: Linked Devices > Link a device > Link with phone number instead');
  console.log('=========================================\n');
  return code;
}

async function connectWhatsApp() {
  let state;
  let saveCreds;

  if (process.env.DATABASE_URL) {
    try {
      const pgAuth = await usePostgresAuthState(pool);
      state = pgAuth.state;
      saveCreds = pgAuth.saveCreds;
    } catch (err) {
      console.warn('Failed to initialize Postgres auth state, falling back to file auth:', err.message);
      const fileAuth = await useMultiFileAuthState(AUTH_DIR);
      state = fileAuth.state;
      saveCreds = fileAuth.saveCreds;
    }
  } else {
    const fileAuth = await useMultiFileAuthState(AUTH_DIR);
    state = fileAuth.state;
    saveCreds = fileAuth.saveCreds;
  }

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'warn' }),
    printQRInTerminal: false, // we handle QR display ourselves below
  });

  sock.ev.on('creds.update', saveCreds);

  // If WHATSAPP_PHONE_NUMBER is configured in environment, auto-request pairing code on startup
  if (!sock.authState?.creds?.registered && process.env.WHATSAPP_PHONE_NUMBER) {
    setTimeout(async () => {
      try {
        await requestPairingCode(process.env.WHATSAPP_PHONE_NUMBER);
      } catch (err) {
        console.error('Auto pairing code request error:', err.message);
      }
    }, 5000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !process.env.WHATSAPP_PHONE_NUMBER) {
      console.log('\nScan this QR code with WhatsApp (or use /pair.html to link via phone number):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      isReady = true;
      console.log('WhatsApp connected.');
    }

    if (connection === 'close') {
      isReady = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('WhatsApp connection closed.', { statusCode, shouldReconnect });

      if (shouldReconnect) {
        connectWhatsApp();
      } else {
        console.log('Logged out from WhatsApp. Clearing session to allow re-linking.');
        if (process.env.DATABASE_URL) {
          pool.query('DELETE FROM whatsapp_auth').catch(() => {});
        }
      }
    }
  });

  return sock;
}

module.exports = {
  connectWhatsApp,
  sendText,
  sendNotification,
  requestPairingCode,
  isReady: () => isReady,
};
