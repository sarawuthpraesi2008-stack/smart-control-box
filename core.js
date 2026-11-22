'use strict';

const STORAGE_KEY = 'smart_control_box_pro_v1';
const FETCH_TIMEOUT_MS = 5000;

const DEFAULT_CHANNELS = [
  { id: 1, name: 'ช่องที่ 1 (GPIO 26)', pin: 'V0', schedPin: 'V6', state: false, pending: false, schedule: null },
  { id: 2, name: 'ช่องที่ 2 (GPIO 27)', pin: 'V1', schedPin: 'V7', state: false, pending: false, schedule: null },
  { id: 3, name: 'ช่องที่ 3 (GPIO 14)', pin: 'V2', schedPin: 'V8', state: false, pending: false, schedule: null },
  { id: 4, name: 'ช่องที่ 4 (GPIO 13)', pin: 'V3', schedPin: 'V9', state: false, pending: false, schedule: null },
];

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hhmmToSec(hhmm) {
  if (!hhmm || !String(hhmm).includes(':')) return '';
  const p = String(hhmm).split(':').map(Number);
  if (p.length < 2 || Number.isNaN(p[0]) || Number.isNaN(p[1])) return '';
  return String(p[0] * 3600 + p[1] * 60);
}

function secToHhmm(sec) {
  if (sec === '' || sec === null || sec === undefined || Number.isNaN(Number(sec))) return '';
  const n = parseInt(sec, 10);
  if (n < 0) return '';
  return `${String(Math.floor(n / 3600) % 24).padStart(2, '0')}:${String(Math.floor((n % 3600) / 60)).padStart(2, '0')}`;
}

// Blynk HTTP API returns V6-V9 Time Input as \0-separated string or array
function parseBlynkTimeInput(raw) {
  const arr = Array.isArray(raw) ? raw : String(raw || '').split('\0');
  if (arr.length < 2) return null;
  const start = secToHhmm(arr[0]);
  const stop = secToHhmm(arr[1]);
  const days = String(arr[3] || '');
  if (!start && !stop) return null;
  return { start, stop, days };
}

function parsePzemCsv(raw) {
  const p = String(raw || '').split(',').map(Number);
  if (p.length >= 6 && !p.some(Number.isNaN)) {
    return { v: p[0], c: p[1], p: p[2], e: p[3], f: p[4], pf: p[5] };
  }
  return null;
}

function getNextResetInfo(lastResetIso, cycleDays, nowDate = new Date()) {
  const days = Number(cycleDays) || 0;
  if (days <= 0) return { enabled: false, due: false, nextResetDate: null, daysRemaining: null };
  const startMs = Date.parse(lastResetIso || '');
  const nowMs = nowDate instanceof Date ? nowDate.getTime() : Date.parse(nowDate);
  if (Number.isNaN(startMs) || Number.isNaN(nowMs)) {
    return { enabled: true, due: false, nextResetDate: null, daysRemaining: days };
  }
  const nextMs = startMs + days * 86400000;
  const diffMs = nextMs - nowMs;
  return {
    enabled: true,
    due: diffMs <= 0,
    nextResetDate: new Date(nextMs),
    daysRemaining: Math.max(0, Math.ceil(diffMs / 86400000)),
  };
}

const coreApi = {
  STORAGE_KEY,
  FETCH_TIMEOUT_MS,
  DEFAULT_CHANNELS,
  esc,
  hhmmToSec,
  secToHhmm,
  parseBlynkTimeInput,
  parsePzemCsv,
  getNextResetInfo,
};

if (typeof window !== 'undefined') {
  window.SCB = Object.assign(window.SCB || {}, coreApi);
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = coreApi;
}
