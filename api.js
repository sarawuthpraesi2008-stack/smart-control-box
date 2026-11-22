'use strict';

(function initApi(SCB) {
  const { STORAGE_KEY, FETCH_TIMEOUT_MS, DEFAULT_CHANNELS, hhmmToSec, parseBlynkTimeInput, parsePzemCsv, getNextResetInfo } = SCB;

  function loadConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(`${STORAGE_KEY}_cfg`) || 'null');
      if (saved && Array.isArray(saved.channels) && saved.channels.length === 4) {
        saved.channels = saved.channels.map((c, i) => ({
          ...DEFAULT_CHANNELS[i],
          ...c,
          schedPin: DEFAULT_CHANNELS[i].schedPin,
          pending: false,
        }));
        return { rate: 4.5, maxAmp: 10.0, resetCycleDays: 0, lastEnergyResetAt: new Date().toISOString(), ...saved };
      }
    } catch (_) {}
    return {
      mode: 'SIMULATION',
      server: 'blynk.cloud',
      token: '',
      gasUrl: '',
      rate: 4.5,
      maxAmp: 10.0,
      resetCycleDays: 0,
      lastEnergyResetAt: new Date().toISOString(),
      channels: JSON.parse(JSON.stringify(DEFAULT_CHANNELS)),
    };
  }

  function loadJson(suffix) {
    try { return JSON.parse(localStorage.getItem(`${STORAGE_KEY}_${suffix}`) || '[]'); } catch (_) { return []; }
  }

  const state = {
    isOnline: true,
    autoMode: false,
    isSyncing: false,
    lastSync: null,
    activeSchedId: 1,
    power: { v: 220.4, c: 0.0, p: 0.0, e: 1.245, f: 50.0, pf: 0.98 },
    smoke: 8,
    simFault: null,
    isTestingSeq: false,
    config: loadConfig(),
    logs: loadJson('logs'),
    billingHistory: loadJson('billing'),
  };

  function saveConfig() { localStorage.setItem(`${STORAGE_KEY}_cfg`, JSON.stringify(state.config)); }
  function saveLogs() { localStorage.setItem(`${STORAGE_KEY}_logs`, JSON.stringify(state.logs.slice(0, 150))); }
  function saveBilling() { localStorage.setItem(`${STORAGE_KEY}_billing`, JSON.stringify(state.billingHistory.slice(0, 50))); }

  async function fetchWithTimeout(url, options = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function pushLog(channel, action, source = 'Web Dashboard', status = 'SUCCESS') {
    const now = new Date();
    const timeShort = now.toLocaleTimeString('th-TH', { hour12: false });
    const dateStr = now.toLocaleDateString('th-TH');
    state.logs.unshift({ timeShort, dateStr, time: `${dateStr} ${timeShort}`, channel, action, source, status });
    saveLogs();

    if (state.config.gasUrl) {
      fetchWithTimeout(state.config.gasUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, action, source, status }),
      }).catch(() => {});
    }
  }

  async function blynkUpdate(params) {
    const base = `https://${state.config.server}/external/api/update?token=${encodeURIComponent(state.config.token)}`;
    const res = await fetchWithTimeout(`${base}&${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  async function blynkBatch(params) {
    const base = `https://${state.config.server}/external/api/batch/update?token=${encodeURIComponent(state.config.token)}`;
    const res = await fetchWithTimeout(`${base}&${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  async function notifySource() {
    try { await blynkUpdate('V14=Web%20Dashboard'); } catch (_) {}
  }

  async function performEnergyReset(reasonLabel, sourceLabel = 'Web Dashboard') {
    const kwh = Number(state.power.e) || 0;
    const rate = Number(state.config.rate) || 4.5;
    const cost = kwh * rate;
    const now = new Date();

    if (state.config.mode === 'LIVE' && state.isOnline && state.config.token) {
      await blynkUpdate('V17=1');
    }

    state.billingHistory.unshift({
      date: now.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }),
      cycle: reasonLabel,
      kwh: kwh.toFixed(3),
      cost: cost.toFixed(2),
    });
    saveBilling();

    state.power.e = 0;
    state.config.lastEnergyResetAt = now.toISOString();
    saveConfig();

    pushLog('PZEM-004T', `สรุปและรีเซ็ตค่าไฟ (${reasonLabel}): ${kwh.toFixed(3)} kWh / ${cost.toFixed(2)} บาท`, sourceLabel);
    if (SCB.render) SCB.render();
  }

  async function checkAutoEnergyReset() {
    const info = getNextResetInfo(state.config.lastEnergyResetAt, state.config.resetCycleDays);
    if (!info.enabled || !info.due) return;
    try {
      await performEnergyReset(`อัตโนมัติ ${state.config.resetCycleDays} วัน`, 'Timer');
      if (SCB.toast) SCB.toast(`รีเซ็ตและบันทึกค่าไฟรอบ ${state.config.resetCycleDays} วันแล้ว`, 'success');
    } catch (_) {}
  }

  async function syncDevice() {
    if (state.isSyncing) return;
    state.isSyncing = true;
    try {
      if (state.config.mode === 'SIMULATION') {
        const activeCh = state.config.channels.filter((c) => c.state).length;
        const maxAmp = Number(state.config.maxAmp) || 10.0;
        const simAmp = state.simFault === 'OVER_AMP'
          ? maxAmp + 1.25
          : activeCh * 1.35 + (activeCh > 0 ? Math.random() * 0.08 : 0);
        state.power.v = 220.2 + (Math.random() * 0.6 - 0.3);
        state.power.c = simAmp;
        state.power.p = state.power.v * simAmp * 0.98;
        state.power.e += (state.power.p / 1000) * (4 / 3600);
        state.power.f = 50.0;
        state.power.pf = activeCh > 0 || state.simFault === 'OVER_AMP' ? 0.98 : 0.0;
        state.smoke = state.simFault === 'SMOKE' ? 76 : 6 + Math.floor(Math.random() * 4);
        state.lastSync = new Date();
        return;
      }

      if (!state.config.token) {
        state.isOnline = false;
        const el = document.getElementById('offlineAlertDetail');
        if (el) el.textContent = 'กรุณาใส่ Blynk Auth Token ในหน้าตั้งค่า';
        return;
      }

      const base = `https://${state.config.server}/external/api`;
      const connRes = await fetchWithTimeout(`${base}/isHardwareConnected?token=${encodeURIComponent(state.config.token)}`);
      state.isOnline = connRes.ok && Boolean(await connRes.json());
      state.lastSync = new Date();

      if (state.isOnline) {
        const getRes = await fetchWithTimeout(
          `${base}/get?token=${encodeURIComponent(state.config.token)}&V0&V1&V2&V3&V5&V6&V7&V8&V9&V15&V16`
        );
        if (getRes.ok) {
          const d = await getRes.json();
          state.config.channels.forEach((ch) => {
            if (!ch.pending && d[ch.pin] !== undefined) ch.state = Number(d[ch.pin]) === 1;
            if (d[ch.schedPin] !== undefined) ch.schedule = parseBlynkTimeInput(d[ch.schedPin]);
          });
          if (d.V5 !== undefined) state.autoMode = Number(d.V5) === 1;
          if (d.V15 !== undefined) {
            const parsed = parsePzemCsv(d.V15);
            if (parsed) state.power = parsed;
          }
          if (d.V16 !== undefined) state.smoke = Number(d.V16) || 0;
        }
      }
    } catch (_) {
      state.isOnline = false;
    } finally {
      state.isSyncing = false;
      if (SCB.render) SCB.render();
      checkAutoEnergyReset();
    }
  }

  async function fetchCloudLogs(silent = true) {
    if (!state.config.gasUrl) return;
    try {
      const res = await fetchWithTimeout(state.config.gasUrl);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data) && data.length) {
        state.logs = data;
        saveLogs();
        if (SCB.renderLogs) SCB.renderLogs();
        if (!silent && SCB.toast) SCB.toast('อัปเดตประวัติล่าสุดแล้ว', 'success');
      }
    } catch (_) {
      if (!silent && SCB.toast) SCB.toast('ดึงประวัติไม่สำเร็จ', 'error');
    }
  }

  async function toggleChannel(id) {
    const ch = state.config.channels.find((c) => c.id === id);
    if (!ch || ch.pending || !state.isOnline) return;
    const prev = ch.state;
    const next = !prev;
    state.autoMode = false;
    ch.state = next;
    ch.pending = true;
    if (SCB.render) SCB.render();

    try {
      if (state.config.mode === 'LIVE') {
        try {
          await blynkBatch(`V14=Web%20Dashboard&${ch.pin}=${next ? 1 : 0}`);
        } catch (_) {
          await blynkUpdate(`${ch.pin}=${next ? 1 : 0}`);
        }
      }
      pushLog(`CH${ch.id} • ${ch.name}`, next ? 'สั่งเปิด (ON)' : 'สั่งปิด (OFF)');
    } catch (e) {
      ch.state = prev;
      if (SCB.toast) SCB.toast(`สั่งงานไม่สำเร็จ (${e.message})`, 'error');
    } finally {
      ch.pending = false;
      if (SCB.render) SCB.render();
    }
  }

  async function saveSchedule(start, stop, daysCsv) {
    const ch = state.config.channels.find((c) => c.id === state.activeSchedId);
    if (!ch) return;
    const isOff = !start && !stop;
    try {
      if (state.config.mode === 'LIVE') {
        if (!state.isOnline) throw new Error('บอร์ด Offline');
        await notifySource();
        const p = ch.schedPin;
        await blynkUpdate(`${p}=${hhmmToSec(start)}&${p}=${hhmmToSec(stop)}&${p}=Asia/Bangkok&${p}=${encodeURIComponent(isOff ? '' : daysCsv)}&${p}=25200`);
      }
      ch.schedule = isOff ? null : { start, stop, days: daysCsv };
      saveConfig();
      pushLog(`CH${ch.id} (${ch.schedPin})`, isOff ? 'ยกเลิกตั้งเวลา' : `ตั้งเวลา ${start || ''} ${stop ? `ปิด ${stop}` : ''}`.trim());
      if (SCB.toast) SCB.toast(isOff ? 'ยกเลิกตั้งเวลาแล้ว' : 'บันทึกตารางเวลาแล้ว', 'success');
    } catch (e) {
      if (SCB.toast) SCB.toast(e.message, 'error');
    }
    const modal = document.getElementById('scheduleModal');
    if (modal) modal.classList.add('hidden');
    if (SCB.render) SCB.render();
  }

  Object.assign(SCB, {
    state,
    saveConfig,
    saveLogs,
    saveBilling,
    pushLog,
    blynkUpdate,
    blynkBatch,
    performEnergyReset,
    checkAutoEnergyReset,
    syncDevice,
    fetchCloudLogs,
    toggleChannel,
    saveSchedule,
  });
})(window.SCB);
