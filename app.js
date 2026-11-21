const STORAGE_KEY = 'smart_control_box_v6_v9';
const DEFAULT_CHANNELS = [
  { id: 1, name: 'ช่องที่ 1 (GPIO 26)', pin: 'V0', schedPin: 'V6', state: false, pending: false, schedule: null },
  { id: 2, name: 'ช่องที่ 2 (GPIO 27)', pin: 'V1', schedPin: 'V7', state: false, pending: false, schedule: null },
  { id: 3, name: 'ช่องที่ 3 (GPIO 14)', pin: 'V2', schedPin: 'V8', state: false, pending: false, schedule: null },
  { id: 4, name: 'ช่องที่ 4 (GPIO 13)', pin: 'V3', schedPin: 'V9', state: false, pending: false, schedule: null }
];

const state = {
  isOnline: true,
  autoMode: false,
  isSyncing: false,
  lastSync: null,
  activeSchedId: 1,
  config: loadConfig(),
  logs: loadLogs()
};

function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY + '_cfg') || 'null');
    if (saved && Array.isArray(saved.channels) && saved.channels.length === 4) {
      saved.channels = saved.channels.map((c, i) => ({
        ...DEFAULT_CHANNELS[i],
        ...c,
        schedPin: DEFAULT_CHANNELS[i].schedPin,
        pending: false
      }));
      return saved;
    }
  } catch (e) {}
  return { mode: 'SIMULATION', server: 'blynk.cloud', token: '', gasUrl: '', channels: JSON.parse(JSON.stringify(DEFAULT_CHANNELS)) };
}

function saveConfig() { localStorage.setItem(STORAGE_KEY + '_cfg', JSON.stringify(state.config)); }
function loadLogs() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY + '_logs') || '[]'); } catch (e) { return []; } }
function saveLogs() { localStorage.setItem(STORAGE_KEY + '_logs', JSON.stringify(state.logs.slice(0, 150))); }
function esc(s) { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; } 

function hhmmToSec(hhmm) {
  if (!hhmm || !hhmm.includes(':')) return '';
  const parts = hhmm.split(':').map(Number);
  return String(parts[0] * 3600 + parts[1] * 60);
}

function secToHhmm(sec) {
  if (sec === '' || sec === null || sec === undefined || isNaN(sec)) return '';
  const n = parseInt(sec, 10);
  return String(Math.floor(n / 3600)).padStart(2, '0') + ':' + String(Math.floor((n % 3600) / 60)).padStart(2, '0');
}
function parseBlynkTimeInput(raw) {
  const arr = Array.isArray(raw) ? raw : String(raw || '').split('\0');
  if (arr.length < 2) return null;
  const start = secToHhmm(arr[0]);
  const stop  = secToHhmm(arr[1]);
  const days  = String(arr[3] || '');
  if (!start && !stop) return null;
  return { start, stop, days };
}
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  const tone = type === 'error' ? 'bg-rose-600 text-white'
             : type === 'success' ? 'bg-blue-600 text-white'
             : 'bg-slate-800 text-white';
  el.className = `px-4 py-2.5 rounded-xl text-xs font-semibold shadow-lg ${tone}`;
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

function pushLog(channel, action, source = 'Web Dashboard', status = 'SUCCESS') {
  const now = new Date();
  const timeShort = now.toLocaleTimeString('th-TH', { hour12: false });
  const dateStr = now.toLocaleDateString('th-TH');
  state.logs.unshift({ timeShort, dateStr, time: `${dateStr} ${timeShort}`, channel, action, source, status });
  saveLogs();

  if (state.config.gasUrl) {
    fetch(state.config.gasUrl, {
      method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, action, source, status })
    }).catch(() => {});
  }
}

async function blynkUpdate(params) {
  const base = `https://${state.config.server}/external/api/update?token=${encodeURIComponent(state.config.token)}`;
  const res = await fetch(`${base}&${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function notifySource() {
  try { await blynkUpdate('V14=Web%20Dashboard'); } catch (e) {}
}

async function syncDevice() {
  if (state.isSyncing) return;
  state.isSyncing = true;
  try {
    if (state.config.mode === 'SIMULATION') {
      state.lastSync = new Date();
      render();
      return;
    }
    if (!state.config.token) {
      state.isOnline = false;
      document.getElementById('offlineAlertDetail').textContent = 'กรุณาใส่ Blynk Auth Token ในหน้าตั้งค่า';
      render();
      return;
    }
    const base = `https://${state.config.server}/external/api`;
    const connRes = await fetch(`${base}/isHardwareConnected?token=${encodeURIComponent(state.config.token)}`);
    state.isOnline = connRes.ok && Boolean(await connRes.json());
    state.lastSync = new Date();

    if (state.isOnline) {
      const getRes = await fetch(`${base}/get?token=${encodeURIComponent(state.config.token)}&V0&V1&V2&V3&V5&V6&V7&V8&V9`);
      if (getRes.ok) {
        const d = await getRes.json();
        state.config.channels.forEach(ch => {
          if (!ch.pending && d[ch.pin] !== undefined) ch.state = Number(d[ch.pin]) === 1;
          if (d[ch.schedPin] !== undefined) ch.schedule = parseBlynkTimeInput(d[ch.schedPin]);
        });
        if (d.V5 !== undefined) state.autoMode = Number(d.V5) === 1;
      }
    }
  } catch (e) {
    state.isOnline = false;
  } finally {
    state.isSyncing = false;
    render();
  }
}
async function toggleChannel(id) {
  const ch = state.config.channels.find(c => c.id === id);
  if (!ch || ch.pending || !state.isOnline) return;
  const prev = ch.state;
  const next = !prev;
  state.autoMode = false;
  ch.state = next;      // ขยับสวิตช์บนหน้าจอทันที (0ms)
  ch.pending = true;
  render();

  try {
    if (state.config.mode === 'LIVE') {
      const base = `https://${state.config.server}/external/api/batch/update?token=${encodeURIComponent(state.config.token)}`;
      const res = await fetch(`${base}&V14=Web%20Dashboard&${ch.pin}=${next ? 1 : 0}`);
      if (!res.ok) await blynkUpdate(`${ch.pin}=${next ? 1 : 0}`);
    }
    pushLog(`CH${ch.id} • ${ch.name}`, next ? 'สั่งเปิด (ON)' : 'สั่งปิด (OFF)');
  } catch (e) {
    ch.state = prev;    // คืนค่าเดิมเฉพาะตอนส่งคำสั่งไม่สำเร็จ
    toast(`สั่งงานไม่สำเร็จ (${e.message})`, 'error');
  } finally {
    ch.pending = false;
    render();
  }
}
  } catch (e) {
    if (!silent) toast('ดึงประวัติไม่สำเร็จ', 'error');
  }
}

async function toggleChannel(id) {
  const ch = state.config.channels.find(c => c.id === id);
  if (!ch || ch.pending || !state.isOnline) return;
  const next = !ch.state;
  state.autoMode = false;
  ch.pending = true;
  renderChannels();

  try {
    if (state.config.mode === 'LIVE') {
      await notifySource();
      await blynkUpdate(`${ch.pin}=${next ? 1 : 0}`);
    }
    ch.state = next;
    pushLog(`CH${ch.id} • ${ch.name}`, next ? 'สั่งเปิด (ON)' : 'สั่งปิด (OFF)');
    toast(`CH0${ch.id}: ${next ? 'เปิด (ON)' : 'ปิด (OFF)'}`, 'success');
  } catch (e) {
    toast(`สั่งงานไม่สำเร็จ (${e.message})`, 'error');
  } finally {
    ch.pending = false;
    render();
  }
}

async function saveSchedule(start, stop, daysCsv) {
  const ch = state.config.channels.find(c => c.id === state.activeSchedId);
  if (!ch) return;
  const isOff = !start && !stop;
  try {
    if (state.config.mode === 'LIVE') {
      if (!state.isOnline) throw new Error('บอร์ด Offline');
      await notifySource();
      const p = ch.schedPin;
      const s1 = hhmmToSec(start), s2 = hhmmToSec(stop);
      await blynkUpdate(`${p}=${s1}&${p}=${s2}&${p}=Asia/Bangkok&${p}=${encodeURIComponent(isOff ? '' : daysCsv)}&${p}=25200`);
    }
    ch.schedule = isOff ? null : { start, stop, days: daysCsv };
    saveConfig();
    const msg = isOff ? 'ยกเลิกตั้งเวลา' : `ตั้งเวลา ${start ? 'เปิด ' + start : ''} ${stop ? 'ปิด ' + stop : ''}`.trim();
    pushLog(`CH${ch.id} (${ch.schedPin})`, msg);
    toast(isOff ? 'ยกเลิกตั้งเวลาแล้ว' : 'บันทึกตารางเวลาแล้ว', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
  document.getElementById('scheduleModal').classList.add('hidden');
  render();
}

function formatSchedule(sched, isOn) {
  if (!sched || (!sched.start && !sched.stop)) {
    return `<span class="${isOn ? 'text-blue-100/80' : 'text-slate-400'}">ไม่ได้ตั้งเวลา</span>`;
  }
  const map = { 1:'จ', 2:'อ', 3:'พ', 4:'พฤ', 5:'ศ', 6:'ส', 7:'อา' };
  const dayList = String(sched.days || '').split(',').filter(Boolean);
  const dayTxt = dayList.length === 7 ? 'ทุกวัน' : dayList.map(d => map[d] || '').join(',');
  const timeTxt = `${sched.start ? sched.start : ''}${sched.stop ? (sched.start ? '–' : 'ปิด ') + sched.stop : ''}`;
  return `<span class="mono font-semibold ${isOn ? 'text-white' : 'text-blue-700'}">⏰ ${timeTxt}</span> <span class="${isOn ? 'text-blue-100' : 'text-slate-500'}">(${dayTxt})</span>`;
}

function render() {
  const isSim = state.config.mode === 'SIMULATION';
  const modeBtn = document.getElementById('btnToggleMode');
  modeBtn.textContent = isSim ? 'SIMULATION' : 'LIVE BLYNK';
  modeBtn.className = isSim
    ? 'mono px-3 py-1.5 rounded-full text-[11px] font-bold bg-amber-400 text-slate-950 hover:bg-amber-300 transition cursor-pointer shadow-sm'
    : 'mono px-3 py-1.5 rounded-full text-[11px] font-bold bg-emerald-400 text-slate-950 hover:bg-emerald-300 transition cursor-pointer shadow-sm';

  document.getElementById('headerLed').className = `w-2.5 h-2.5 rounded-full ${state.isOnline ? 'bg-emerald-300 shadow-[0_0_10px_#6ee7b7]' : 'bg-rose-400 shadow-[0_0_10px_#fb7185]'}`;
  document.getElementById('deviceStatusText').textContent = state.isOnline ? 'ONLINE' : 'OFFLINE';
  document.getElementById('offlineAlert').classList.toggle('hidden', state.isOnline);
  if (state.lastSync) document.getElementById('lastSyncTime').textContent = state.lastSync.toLocaleTimeString('th-TH', { hour12: false });

  const sheetBadge = document.getElementById('sheetSyncStatus');
  sheetBadge.textContent = state.config.gasUrl ? 'SHEETS SYNC' : 'LOCAL';
  sheetBadge.className = state.config.gasUrl
    ? 'mono text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold'
    : 'mono text-[10px] px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-500 font-semibold';

  document.getElementById('activeCount').textContent = state.config.channels.filter(c => c.state).length;
  document.getElementById('miniLoadBars').innerHTML = state.config.channels.map((c, i) =>
    `<div class="w-2 ${['h-2.5','h-4','h-5','h-7'][i]} rounded-sm transition-colors ${c.state ? 'bg-blue-600' : 'bg-slate-200'}"></div>`
  ).join('');

  const autoBtn = document.getElementById('btnAutoMode');
  const autoThumb = document.getElementById('autoModeThumb');
  autoBtn.setAttribute('aria-checked', state.autoMode);
  autoBtn.className = `switch-track relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border p-1 cursor-pointer ${state.autoMode ? 'bg-blue-600 border-blue-600' : 'bg-slate-100 border-slate-300'}`;
  autoThumb.className = `switch-knob inline-block h-4 w-4 rounded-full ${state.autoMode ? 'bg-white translate-x-5' : 'bg-slate-400 translate-x-0'}`;

  renderChannels();
  renderLogs();
}

function renderChannels() {
  const off = !state.isOnline;
  document.getElementById('channelGrid').innerHTML = state.config.channels.map(ch => {
    const isOn = ch.state;
    return `
      <div class="card-soft rounded-2xl overflow-hidden flex flex-col justify-between ${isOn ? 'border-blue-400/70' : ''}">
        <!-- White Upper Hardware Section -->
        <div class="p-4 pb-5 space-y-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="mono text-[11px] font-bold px-2 py-0.5 rounded-md ${isOn ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'}">CH 0${ch.id}</span>
              <span class="mono text-[10px] text-slate-400">${ch.pin}/${ch.schedPin}</span>
            </div>
            <span class="w-2.5 h-2.5 rounded-full ${isOn ? 'bg-cyan-400 shadow-[0_0_8px_#22d3ee]' : 'bg-slate-200'}"></span>
          </div>

          <div class="flex items-center justify-between gap-2">
            <h3 class="text-sm font-bold text-slate-800 leading-snug">${esc(ch.name)}</h3>
            <button type="button" role="switch" aria-checked="${isOn}" data-ch="${ch.id}" ${off || ch.pending ? 'disabled' : ''}
              class="ch-switch switch-track relative inline-flex h-7 w-13 shrink-0 items-center rounded-full border p-1 ${isOn ? 'bg-blue-600 border-blue-600' : 'bg-slate-100 border-slate-300'} ${off ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}" style="width: 3.1rem;">
              <span class="switch-knob inline-block h-4 w-4 rounded-full ${isOn ? 'bg-white translate-x-5' : 'bg-slate-400 translate-x-0'}"></span>
            </button>
          </div>
        </div>

        <!-- Split-Tone Bottom Strip (Blue-Cyan Gradient when ON) -->
        <div class="px-4 py-3 flex items-center justify-between text-[11px] transition-colors ${isOn ? 'card-footer-on text-white' : 'bg-slate-50 border-t border-slate-100 text-slate-600'}">
          <div class="truncate pr-2">${formatSchedule(ch.schedule, isOn)}</div>
          <button type="button" data-sched="${ch.id}" class="ch-sched font-semibold underline shrink-0 cursor-pointer ${isOn ? 'text-white hover:text-blue-100' : 'text-blue-600 hover:text-blue-800'}">ตั้งเวลา</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderLogs() {
  const filter = document.getElementById('logFilter').value;
  const list = state.logs.filter(l => filter === 'ALL' || String(l.source || '').includes(filter));
  const tbody = document.getElementById('logTableBody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="py-8 text-center text-slate-400 text-xs">ไม่มีประวัติการทำงาน</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(l => {
    const s = String(l.source || 'Web');
    const badge = s.includes('LINE') ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                : s.includes('Blynk') ? 'text-sky-700 bg-sky-50 border-sky-200'
                : s.includes('Timer') ? 'text-amber-700 bg-amber-50 border-amber-200'
                : 'text-blue-700 bg-blue-50 border-blue-200';
    return `
      <tr class="hover:bg-slate-50">
        <td class="py-2.5 px-5 mono text-slate-500 whitespace-nowrap" title="${esc(l.dateStr || '')}">${esc(l.timeShort || l.time)}</td>
        <td class="py-2.5 px-4 font-semibold text-slate-800 whitespace-nowrap">${esc(l.channel)}</td>
        <td class="py-2.5 px-4 text-slate-600">${esc(l.action)}</td>
        <td class="py-2.5 px-5 text-right whitespace-nowrap">
          <span class="mono text-[10px] font-semibold px-2.5 py-0.5 rounded-full border ${badge}">${esc(s)}</span>
        </td>
      </tr>`;
  }).join('');
}

document.getElementById('btnToggleMode').onclick = () => {
  state.config.mode = state.config.mode === 'SIMULATION' ? 'LIVE' : 'SIMULATION';
  if (state.config.mode === 'SIMULATION') state.isOnline = true;
  saveConfig();
  syncDevice();
};
document.getElementById('btnManualSync').onclick = syncDevice;
document.getElementById('btnRetrySync').onclick = syncDevice;
document.getElementById('btnFetchCloudLogs').onclick = () => fetchCloudLogs(false);
document.getElementById('logFilter').onchange = renderLogs;

document.getElementById('btnAutoMode').onclick = async () => {
  if (!state.isOnline) return;
  const next = !state.autoMode;
  try {
    if (state.config.mode === 'LIVE') { await notifySource(); await blynkUpdate(`V5=${next ? 1 : 0}`); }
    state.autoMode = next;
    if (!next) state.config.channels.forEach(c => c.state = false);
    pushLog('AUTO MODE (V5)', next ? 'เปิดโหมดไฟวิ่ง' : 'ปิดโหมดไฟวิ่ง');
    render();
  } catch (e) { toast(e.message, 'error'); }
};

document.getElementById('btnAllOn').onclick = async () => {
  if (!state.isOnline) return;
  try {
    if (state.config.mode === 'LIVE') { await notifySource(); await blynkUpdate('V4=1'); }
    state.autoMode = false;
    state.config.channels.forEach(c => c.state = true);
    pushLog('MASTER (V4)', 'เปิดทั้งหมด (ALL ON)');
    render();
  } catch (e) { toast(e.message, 'error'); }
};

document.getElementById('btnAllOffPrompt').onclick = () => document.getElementById('confirmModal').classList.remove('hidden');
document.getElementById('btnCancelConfirm').onclick = () => document.getElementById('confirmModal').classList.add('hidden');
document.getElementById('btnConfirmAllOff').onclick = async () => {
  document.getElementById('confirmModal').classList.add('hidden');
  if (!state.isOnline) return;
  try {
    if (state.config.mode === 'LIVE') { await notifySource(); await blynkUpdate('V4=0'); }
    state.autoMode = false;
    state.config.channels.forEach(c => c.state = false);
    pushLog('MASTER (V4)', 'ปิดทั้งหมด (ALL OFF)');
    render();
  } catch (e) { toast(e.message, 'error'); }
};

document.getElementById('channelGrid').onclick = (e) => {
  const sw = e.target.closest('.ch-switch');
  if (sw && !sw.disabled) return toggleChannel(Number(sw.dataset.ch));
  const sc = e.target.closest('.ch-sched');
  if (sc) {
    state.activeSchedId = Number(sc.dataset.sched);
    const ch = state.config.channels.find(c => c.id === state.activeSchedId);
    document.getElementById('schedModalTitle').textContent = `ตั้งเวลา (${ch.schedPin}): ${ch.name}`;
    document.getElementById('schedStart').value = ch.schedule?.start || '';
    document.getElementById('schedStop').value = ch.schedule?.stop || '';
    const days = String(ch.schedule?.days || '');
    document.querySelectorAll('#weekdaySelector input').forEach(cb => cb.checked = !days || days.includes(cb.value));
    document.getElementById('scheduleModal').classList.remove('hidden');
  }
};

document.getElementById('btnCloseSchedX').onclick = () => document.getElementById('scheduleModal').classList.add('hidden');
document.getElementById('btnCancelSched').onclick = () => document.getElementById('scheduleModal').classList.add('hidden');
document.getElementById('btnClearSchedule').onclick = () => saveSchedule('', '', '');
document.getElementById('btnSaveSchedule').onclick = () => {
  const st = document.getElementById('schedStart').value;
  const sp = document.getElementById('schedStop').value;
  const days = [...document.querySelectorAll('#weekdaySelector input:checked')].map(c => c.value).join(',');
  if (!st && !sp) return toast('กรุณาระบุเวลาอย่างน้อย 1 ช่อง', 'error');
  if (!days) return toast('กรุณาเลือกวันทำงาน', 'error');
  saveSchedule(st, sp, days);
};

document.getElementById('btnOpenSettings').onclick = () => {
  document.getElementById('cfgServer').value = state.config.server;
  document.getElementById('cfgToken').value = state.config.token;
  document.getElementById('cfgGasUrl').value = state.config.gasUrl || '';
  document.getElementById('channelConfigInputs').innerHTML = state.config.channels.map(ch => `
    <div class="flex items-center gap-2">
      <span class="mono text-slate-400 w-8">0${ch.id}</span>
      <input id="cfgName_${ch.id}" type="text" value="${esc(ch.name)}" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 text-slate-800 focus:border-blue-500 focus:outline-none" />
    </div>
  `).join('');
  document.getElementById('settingsModal').classList.remove('hidden');
};
document.getElementById('btnCloseSettingsX').onclick = () => document.getElementById('settingsModal').classList.add('hidden');
document.getElementById('btnCancelSettings').onclick = () => document.getElementById('settingsModal').classList.add('hidden');
document.getElementById('btnSaveSettings').onclick = () => {
  state.config.server = document.getElementById('cfgServer').value.trim() || 'blynk.cloud';
  state.config.token = document.getElementById('cfgToken').value.trim();
  state.config.gasUrl = document.getElementById('cfgGasUrl').value.trim();
  state.config.channels.forEach(ch => {
    const v = document.getElementById(`cfgName_${ch.id}`).value.trim();
    if (v) ch.name = v;
  });
  saveConfig();
  document.getElementById('settingsModal').classList.add('hidden');
  toast('บันทึกการตั้งค่าแล้ว', 'success');
  syncDevice();
  fetchCloudLogs(true);
};

render();
syncDevice();
fetchCloudLogs(true);
setInterval(syncDevice, 4000);
setInterval(() => fetchCloudLogs(true), 10000);
