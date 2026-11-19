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
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const path = require('path');
const pino = require('pino');

const AUTH_DIR = path.join(__dirname, '..', 'auth');

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
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

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
        console.log('Logged out from WhatsApp. Delete the ./auth folder and restart to re-link.');
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
