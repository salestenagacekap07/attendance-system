// Lightweight WhatsApp stub for direct 1-tap WhatsApp gateway.
// Replaced legacy companion Baileys bot to eliminate memory overhead and ban risks.

function cleanPhoneNumber(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('0')) {
    digits = '60' + digits.slice(1);
  }
  return digits;
}

async function sendNotification(_phoneNumber, _text, _image = null) {
  return true;
}

async function sendText(_phoneNumber, _text) {
  return true;
}

function isReady() {
  return false;
}

function getSocket() {
  return null;
}

async function connectWhatsApp() {
  return null;
}

async function resetWhatsAppSession() {
  return true;
}

async function requestPairingCode(_phoneNumber) {
  throw new Error('Companion pairing is deprecated. System uses 1-Tap Direct WhatsApp Gateway.');
}

module.exports = {
  cleanPhoneNumber,
  sendNotification,
  sendText,
  isReady,
  getSocket,
  connectWhatsApp,
  resetWhatsAppSession,
  requestPairingCode,
};
