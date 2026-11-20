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
  makeCacheableSignalKeyStore,
  Browsers,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const NodeCacheModule = require('@cacheable/node-cache');
const NodeCache = NodeCacheModule.NodeCache || NodeCacheModule.default || NodeCacheModule;
const qrcode = require('qrcode-terminal');
const path = require('path');
const pino = require('pino');
const { pool } = require('./db');

const AUTH_DIR = path.join(__dirname, '..', 'auth');
const msgRetryCounterCache = new NodeCache();

async function usePostgresAuthState(pgPool) {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id TEXT PRIMARY KEY,
      message JSONB NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
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
          if (!ids || ids.length === 0) return data;
          const fullKeys = ids.map((id) => `${type}-${id}`);
          try {
            const res = await pgPool.query(
              `SELECT id, value FROM whatsapp_auth WHERE id = ANY($1)`,
              [fullKeys]
            );
            const map = new Map();
            for (const row of res.rows) {
              map.set(row.id, JSON.parse(row.value, BufferJSON.reviver));
            }
            for (const id of ids) {
              let value = map.get(`${type}-${id}`) || null;
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }
          } catch (err) {
            console.error(`Error batch reading keys for ${type}:`, err.message);
          }
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

// Store recently sent messages so Baileys can re-encrypt them when WhatsApp requests retry
const sentMessagesStore = new Map();

async function saveSentMessage(id, message) {
  if (!id || !message) return;
  sentMessagesStore.set(id, message);
  if (sentMessagesStore.size > 500) {
    const firstKey = sentMessagesStore.keys().next().value;
    sentMessagesStore.delete(firstKey);
  }
  if (process.env.DATABASE_URL) {
    try {
      await pool.query(
        `INSERT INTO whatsapp_messages (id, message)
         VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET message = EXCLUDED.message`,
        [id, JSON.stringify(message)]
      );
    } catch (err) {
      console.warn('Failed to persist sent message to DB:', err.message);
    }
  }
}

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

      // Check onWhatsApp to warm up the recipient Signal pre-key exchange before sending
      let targetJid = jid;
      try {
        const rawDigits = jid.replace(/@.*$/, '');
        const onWa = await sock.onWhatsApp(rawDigits);
        if (Array.isArray(onWa) && onWa[0]?.exists && onWa[0]?.jid) {
          targetJid = onWa[0].jid;
        }
      } catch (e) {
        // Fall back to original jid
      }

      // 1. Send the primary text notification with approval link first
      const sentText = await sock.sendMessage(targetJid, { text });
      if (sentText?.key?.id && sentText?.message) {
        await saveSentMessage(sentText.key.id, sentText.message);
      }

      // 2. If a verification selfie photo is attached, pause 1.5s to let text handshake settle, then send photo
      if (image) {
        try {
          await new Promise((r) => setTimeout(r, 1500));
          let buffer;
          if (Buffer.isBuffer(image)) {
            buffer = image;
          } else if (typeof image === 'string') {
            const cleanBase64 = image.replace(/^data:image\/\w+;base64,/, '');
            buffer = Buffer.from(cleanBase64, 'base64');
          }
          const sentImg = await sock.sendMessage(targetJid, { image: buffer, caption: '📸 Live Verification Photo' });
          if (sentImg?.key?.id && sentImg?.message) {
            await saveSentMessage(sentImg.key.id, sentImg.message);
          }
        } catch (imgErr) {
          console.warn('Failed to send photo over WhatsApp:', imgErr.message);
        }
      }

      resolve(true);
    } catch (err) {
      console.error('Failed to send WhatsApp message to', jid, err.message);
      reject(err);
    }
    // Pace sends so this doesn't look like a bulk-blasting bot.
    await new Promise((r) => setTimeout(r, randomDelayMs(800, 2000)));
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

  const logger = pino({ level: 'warn' });
  const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
    version: [2, 3000, 1043857760],
    isLatest: true,
  }));
  console.log(`Connecting to WhatsApp with version [${version.join('.')}] (isLatest: ${isLatest})`);

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: Browsers.ubuntu('Chrome'),
    msgRetryCounterCache,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: (jid) => jid?.endsWith('@broadcast') || jid?.includes('newsletter'),
    printQRInTerminal: false, // we handle QR display ourselves below
    getMessage: async (key) => {
      if (!key || !key.id) return undefined;
      // 1. Check in-memory fast cache
      if (sentMessagesStore.has(key.id)) {
        return sentMessagesStore.get(key.id);
      }
      // 2. Check PostgreSQL persistent store
      if (process.env.DATABASE_URL) {
        try {
          const res = await pool.query('SELECT message FROM whatsapp_messages WHERE id = $1', [key.id]);
          if (res.rows.length > 0) {
            const raw = res.rows[0].message;
            return typeof raw === 'string' ? JSON.parse(raw) : raw;
          }
        } catch (err) {
          console.warn('Error reading message from DB in getMessage:', err.message);
        }
      }
      // If message not available, return undefined (do NOT return empty object to prevent sending blank retries)
      return undefined;
    },
  });

  sock.ev.on('creds.update', saveCreds);

  // Auto-respond to incoming messages to establish bidirectional E2E session
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.key.fromMe && msg.key.remoteJid && !msg.key.remoteJid.endsWith('@g.us')) {
        const senderJid = msg.key.remoteJid;
        console.log('Received inbound WhatsApp message from:', senderJid);
        try {
          const reply = await sock.sendMessage(senderJid, {
            text: '👋 Hello! Attendance Verification Bot is connected.\n\nYou will receive live cleaner Time In & Time Out approval alerts directly in this chat.',
          });
          if (reply?.key?.id && reply?.message) {
            await saveSentMessage(reply.key.id, reply.message);
          }
        } catch (e) {
          console.error('Failed to auto-reply to inbound message:', e.message);
        }
      }
    }
  });

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
        setTimeout(() => connectWhatsApp(), 3000);
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

async function resetWhatsAppSession() {
  isReady = false;
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.end();
    } catch (e) {
      console.warn('Error ending socket on reset:', e.message);
    }
    sock = null;
  }
  if (process.env.DATABASE_URL) {
    try {
      await pool.query('DELETE FROM whatsapp_auth');
    } catch (e) {
      console.warn('Error clearing whatsapp_auth on reset:', e.message);
    }
  }
  await connectWhatsApp();
  return true;
}

module.exports = {
  connectWhatsApp,
  sendText,
  sendNotification,
  requestPairingCode,
  resetWhatsAppSession,
  isReady: () => isReady,
  getSocket: () => sock,
};
