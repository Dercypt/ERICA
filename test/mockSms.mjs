let isAvailable = true;
let lastSent = null;
let sendResult = { result: 'sent' };

export async function isAvailableAsync() {
  return isAvailable;
}

export async function sendSMSAsync(addresses, message, options) {
  lastSent = { addresses, message, options };
  return sendResult;
}

export function setMockSmsAvailable(val) {
  isAvailable = val;
}

export function setMockSendResult(val) {
  sendResult = val;
}

export function getLastSentSms() {
  return lastSent;
}

export function resetMockSms() {
  isAvailable = true;
  lastSent = null;
  sendResult = { result: 'sent' };
}

export default {
  isAvailableAsync,
  sendSMSAsync,
  setMockSmsAvailable,
  setMockSendResult,
  getLastSentSms,
  resetMockSms,
};
