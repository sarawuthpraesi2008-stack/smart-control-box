'use strict';

(function initUI(SCB) {
  const {
    state, esc, clampSafetyThresholds, getNextResetInfo, saveConfig, saveBilling,
    pushLog, blynkBatch, performEnergyReset, syncSettingsToCloud,
    recordPowerHistory, syncDevice, fetchCloudConfig, fetchCloudLogs, fetchBillingHistory, toggleChannel, saveSchedule,
  } = SCB;

  const $ = (id) => document.getElementById(id);

  const THEME_KEY = `${SCB.STORAGE_KEY}_theme`;
  let currentTheme = localStorage.getItem(THEME_KEY) || 'dark';

  const ICON_SUN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
  const ICON_MOON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  const ICON_VOL_ON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
  const ICON_VOL_OFF = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', currentTheme);
    const btn = $('btnToggleTheme');
    if (btn) btn.innerHTML = currentTheme === 'dark' ? ICON_SUN : ICON_MOON;
  }

  const SOUND_KEY = `${SCB.STORAGE_KEY}_sound`;
  let mq2WarmupSec = 0;
  let mq2WarmupTimer = null;
  let wasLiveOnline = false;
  let ackFaultKey = null;

  function startMq2Warmup(seconds = 60) {
    mq2WarmupSec = Math.max(0, Number(seconds) || 0);
    if (mq2WarmupTimer) clearInterval(mq2WarmupTimer);
    if (mq2WarmupSec <= 0) {
      mq2WarmupTimer = null;
      return;
    }
    mq2WarmupTimer = setInterval(() => {
      mq2WarmupSec = Math.max(0, mq2WarmupSec - 1);
      if (mq2WarmupSec === 0) {
        clearInterval(mq2WarmupTimer);
        mq2WarmupTimer = null;
      }
      renderPowerAndSafety();
    }, 1000);
  }
  let soundEnabled = localStorage.getItem(SOUND_KEY) !== 'false';
  let audioCtx = null;
  let alarmTimer = null;

  function ensureAudio() {
    if (!soundEnabled) return null;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return audioCtx;
    } catch (_) { return null; }
  }

  function playTone(freq, durationSec, type = 'sine', gainVal = 0.08, delaySec = 0) {
    const ctx = ensureAudio();
    if (!ctx) return;
    try {
      const now = ctx.currentTime + delaySec;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(gainVal, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + durationSec);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + durationSec);
    } catch (_) {}
  }

  function playSound(kind) {
    if (!soundEnabled) return;
    if (kind === 'click') {
      playTone(520, 0.035, 'triangle', 0.09, 0);
      playTone(260, 0.025, 'sine', 0.06, 0.02);
    } else if (kind === 'success') {
      playTone(1046, 0.09, 'sine', 0.06, 0);
      playTone(1318, 0.14, 'sine', 0.06, 0.08);
    } else if (kind === 'error') {
      playTone(320, 0.08, 'sawtooth', 0.10, 0);
      playTone(240, 0.12, 'sawtooth', 0.10, 0.09);
    } else if (kind === 'alarm') {
      // High-urgency industrial dual-tone siren (louder + piercing sweep)
      playTone(1380, 0.18, 'sawtooth', 0.28, 0);
      playTone(960,  0.20, 'square',   0.26, 0.19);
      playTone(1480, 0.18, 'sawtooth', 0.28, 0.40);
      playTone(980,  0.22, 'square',   0.26, 0.59);
    }
  }

  function syncAlarmLoop(isDanger) {
    if (isDanger && soundEnabled) {
      if (!alarmTimer) {
        playSound('alarm');
        alarmTimer = setInterval(() => {
          if (soundEnabled) playSound('alarm');
        }, 950);
      }
    } else if (alarmTimer) {
      clearInterval(alarmTimer);
      alarmTimer = null;
    }
  }

  function renderSoundButton() {
    const btn = $('btnToggleSound');
    if (!btn) return;
    btn.innerHTML = soundEnabled ? ICON_VOL_ON : ICON_VOL_OFF;
    btn.setAttribute('aria-pressed', String(soundEnabled));
    btn.classList.toggle('is-muted', !soundEnabled);
  }

  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast-item ${type === 'error' ? 'is-error' : type === 'success' ? 'is-success' : ''}`;
    el.textContent = msg;
    $('toastContainer').appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }

  function formatSchedule(sched, isOn) {
    if (!sched || (!sched.start && !sched.stop)) {
      return `<span style="opacity:${isOn ? '0.82' : '0.7'};">ไม่ได้ตั้งเวลา</span>`;
    }
    const map = { 1: 'จ', 2: 'อ', 3: 'พ', 4: 'พฤ', 5: 'ศ', 6: 'ส', 7: 'อา' };
    const dayList = String(sched.days || '').split(',').filter(Boolean);
    const dayTxt = dayList.length === 7 ? 'ทุกวัน' : dayList.map((d) => map[d] || '').join(',');
    const timeTxt = `${sched.start || ''}${sched.stop ? (sched.start ? '–' : 'ปิด ') + sched.stop : ''}`;
    return `<span class="mono" style="font-weight:700;">${esc(timeTxt)}</span> <span style="opacity:0.86;">(${esc(dayTxt)})</span>`;
  }

  function renderPowerAndSafety() {
    const { v, c, p, e, f, pf } = state.power;
    const { maxVolt, maxAmp, maxSmoke } = clampSafetyThresholds(state.config);
    const rate = Number(state.config.rate) || 4.5;
    const isOverVolt = v >= maxVolt;
    const isOverAmp = c >= maxAmp;
    const isSmokeDanger = state.smoke >= maxSmoke;

    $('lblMasterThresholds').textContent = `${maxVolt}V · ${maxAmp.toFixed(1)}A · ${maxSmoke}%`;
    $('lblPzemLimits').textContent = `Open CT สายเมนรวม • ตัดไฟเมื่อ ≥ ${maxVolt}V หรือ ≥ ${maxAmp.toFixed(1)}A`;
    $('lblSmokeLimit').textContent = `GPIO 34 • V12 • ตัดไฟ ≥ ${maxSmoke}%`;

    $('valVoltage').textContent = `${v.toFixed(1)}V`;
    $('valVoltage').className = `mono pzem-val ${isOverVolt ? 'is-danger' : ''}`;
    $('valCurrent').textContent = `${c.toFixed(3)}A`;
    $('valCurrent').className = `mono pzem-val ${isOverAmp ? 'is-danger' : ''}`;
    $('valPower').textContent = `${Math.round(p)}W`;
    $('valEnergy').textContent = `${e.toFixed(3)}kWh`;
    $('valFreq').textContent = `${f.toFixed(1)}Hz`;
    $('valPf').textContent = pf.toFixed(2);

    $('lblRate').textContent = `${rate.toFixed(2)} ฿/หน่วย`;
    $('valCost').textContent = (e * rate).toFixed(2);
    const resetInfo = getNextResetInfo(state.config.lastEnergyResetAt, state.config.resetCycleDays);
    $('lblResetCycle').textContent = resetInfo.enabled
      ? `รีเซ็ตทุก ${state.config.resetCycleDays} วัน (อีก ${resetInfo.daysRemaining} วัน)`
      : 'รอบรีเซ็ต: รีเซ็ตเอง';

    $('valSmoke').textContent = `${state.smoke}%`;
    const bar = $('smokeBar');
    bar.style.width = `${Math.min(100, state.smoke)}%`;
    bar.style.background = isSmokeDanger ? '#dc2626' : state.smoke >= Math.round(maxSmoke * 0.6) ? '#f59e0b' : '#10b981';

    const isWarmingUp = mq2WarmupSec > 0;
    const warmupRow = $('mq2WarmupRow');
    if (warmupRow) warmupRow.classList.toggle('hidden', !isWarmingUp);
    if ($('mq2WarmupSec')) $('mq2WarmupSec').textContent = String(mq2WarmupSec);

    const badge = $('smokeBadge');
    if (isWarmingUp) {
      badge.textContent = `WARM-UP ${mq2WarmupSec}s`;
      badge.className = 'mono smoke-badge is-warmup';
    } else {
      badge.textContent = isSmokeDanger ? 'SMOKE ALERT' : 'SAFE';
      badge.className = `mono smoke-badge ${isSmokeDanger ? 'is-danger' : ''}`;
    }

    const loadPct = Math.min(100, Math.round((c / maxAmp) * 100));
    $('lblLoadPct').textContent = `${loadPct}% (${c.toFixed(2)} / ${maxAmp.toFixed(1)}A)`;
    const loadFill = $('loadGaugeFill');
    loadFill.style.width = `${loadPct}%`;
    loadFill.style.background = loadPct >= 100 ? '#E05252' : loadPct >= 75 ? '#E09F3E' : '#C5794B';

    const hist = state.powerHistory.length ? state.powerHistory : [Math.round(p)];
    const maxW = Math.max(100, ...hist);
    $('lblSparkMax').textContent = `${Math.round(p)}W (Peak ${maxW}W)`;
    const pts = hist.length === 1
      ? `0,${30 - Math.round((hist[0] / maxW) * 26)} 200,${30 - Math.round((hist[0] / maxW) * 26)}`
      : hist.map((wVal, idx) => {
          const x = Math.round((idx / (hist.length - 1)) * 200);
          const y = 30 - Math.round((wVal / maxW) * 26);
          return `${x},${y}`;
        }).join(' ');
    $('sparkLinePath').setAttribute('points', pts);

    const effectiveSmokeDanger = isSmokeDanger && !isWarmingUp;
    const isDanger = effectiveSmokeDanger || isOverAmp || isOverVolt;
    const alertEl = $('safetyAlert');
    const emergencyEl = $('emergencyModal');
    if (isDanger) {
      const faultKey = effectiveSmokeDanger ? 'SMOKE' : isOverVolt ? 'OVER_VOLT' : 'OVER_AMP';
      const titleTxt = effectiveSmokeDanger
        ? 'อันตราย! ตรวจพบควันในตู้ควบคุม (MQ-2)'
        : isOverVolt
          ? 'อันตราย! แรงดันไฟฟ้าเกินพิกัด (Over-Voltage)'
          : 'อันตราย! กระแสไฟฟ้าเกินพิกัด (Over-Current)';
      const detailTxt = effectiveSmokeDanger
        ? `ระดับควัน ${state.smoke}% เกินเกณฑ์ ${maxSmoke}% — ระบบสั่งตัดปลั๊กทั้ง 4 ช่องอัตโนมัติ`
        : isOverVolt
          ? `แรงดัน ${v.toFixed(1)}V เกินเกณฑ์ ${maxVolt}V — ระบบสั่งตัดปลั๊กทั้ง 4 ช่องอัตโนมัติ`
          : `กระแส ${c.toFixed(2)}A เกินเกณฑ์ ${maxAmp.toFixed(1)}A — ระบบสั่งตัดปลั๊กทั้ง 4 ช่องอัตโนมัติ`;

      alertEl.classList.remove('hidden');
      $('safetyAlertText').textContent = detailTxt;

      if (emergencyEl && ackFaultKey !== faultKey) {
        $('emergencyTitle').textContent = titleTxt;
        $('emergencyDetail').textContent = detailTxt;
        if ($('btnEmergencyReset')) {
          $('btnEmergencyReset').classList.toggle('hidden', state.config.mode !== 'SIMULATION');
        }
        emergencyEl.classList.remove('hidden');
      }
    } else {
      ackFaultKey = null;
      alertEl.classList.add('hidden');
      if (emergencyEl) emergencyEl.classList.add('hidden');
    }
    syncAlarmLoop(isDanger);
  }

  function renderChannels() {
    const off = !state.isOnline;
    $('channelGrid').innerHTML = state.config.channels.map((ch) => {
      const isOn = ch.state;
      return `
        <div class="ch-card ${isOn ? 'is-on' : ''} ${ch.pending ? 'is-pending' : ''}">
          <div class="ch-body">
            <div class="ch-top">
              <div class="ch-id-group"><span class="ch-num">0${ch.id}</span><span class="ch-pins mono">${ch.pin}/${ch.schedPin}</span></div>
              <span class="ch-state-pill mono">${ch.pending ? 'SYNC' : isOn ? 'ON' : 'OFF'}</span>
            </div>
            <div class="ch-main-row">
              <h3 class="ch-name">${esc(ch.name)}</h3>
              <button type="button" role="switch" aria-checked="${isOn}" data-ch="${ch.id}" data-testid="ch-switch-${ch.id}" ${off || ch.pending ? 'disabled' : ''}
                class="ch-switch switch-track ${isOn ? 'is-on' : ''}">
                <span class="switch-knob"></span>
              </button>
            </div>
          </div>
          <div class="ch-foot">
            <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${formatSchedule(ch.schedule, isOn)}</div>
            <button type="button" data-sched="${ch.id}" data-testid="ch-sched-${ch.id}" class="ch-sched ch-sched-btn">ตั้งเวลา</button>
          </div>
        </div>`;
    }).join('');
  }

  function renderLogs() {
    const filter = $('logFilter').value;
    const list = state.logs.filter((l) => filter === 'ALL' || String(l.source || '').includes(filter));
    const tbody = $('logTableBody');
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="padding:28px;text-align:center;color:var(--text-muted);">ไม่มีประวัติการทำงาน</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((l) => {
      const s = String(l.source || 'Web');
      const cls = s.includes('Safety') ? 'src-safety'
        : s.includes('LINE') ? 'src-line'
        : s.includes('Blynk') ? 'src-blynk'
        : s.includes('Timer') ? 'src-timer'
        : 'src-web';
      return `
        <tr>
          <td class="mono" style="color:var(--text-muted);" title="${esc(l.dateStr || '')}">${esc(l.timeShort || l.time)}</td>
          <td style="font-weight:600;">${esc(l.channel)}</td>
          <td style="color:var(--text-secondary);">${esc(l.action)}</td>
          <td class="td-right"><span class="src-badge ${cls} mono">${esc(s)}</span></td>
        </tr>`;
    }).join('');
  }

  function renderBillingTable() {
    const tbody = $('billingTableBody');
    if (!state.billingHistory.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="padding:24px;text-align:center;color:var(--text-muted);">ยังไม่มีประวัติการบันทึกค่าไฟ</td></tr>';
      return;
    }
    tbody.innerHTML = state.billingHistory.map((b) => `
      <tr>
        <td class="mono" style="color:var(--text-muted);">${esc(b.date)}</td>
        <td>${esc(b.cycle)}</td>
        <td class="td-right mono">${esc(b.kwh)}</td>
        <td class="td-right mono" style="font-weight:700;color:var(--cobalt);">${esc(b.cost)}</td>
      </tr>`).join('');
  }

  function render() {
    const isSim = state.config.mode === 'SIMULATION';
    if (!isSim && state.isOnline && !wasLiveOnline) {
      wasLiveOnline = true;
      startMq2Warmup(60);
    } else if (isSim || !state.isOnline) {
      wasLiveOnline = false;
      if (!isSim) startMq2Warmup(0);
    }
    const modeBtn = $('btnToggleMode');
    modeBtn.textContent = isSim ? 'SIMULATION' : 'LIVE BLYNK';
    modeBtn.classList.toggle('is-live', !isSim);
    $('simTestBar').classList.toggle('hidden', !isSim);

    $('headerLed').className = `led-dot ${state.isOnline ? '' : 'is-offline'}`;
    $('deviceStatusText').textContent = state.isOnline ? 'ONLINE' : 'OFFLINE';
    $('offlineAlert').classList.toggle('hidden', state.isOnline);
    if (state.lastSync) $('lastSyncTime').textContent = state.lastSync.toLocaleTimeString('th-TH', { hour12: false });

    const sheetBadge = $('sheetSyncStatus');
    sheetBadge.textContent = state.config.gasUrl ? 'SHEETS SYNC' : 'LOCAL';
    sheetBadge.style.background = state.config.gasUrl ? '#e0f5ec' : '#e8eff7';
    sheetBadge.style.color = state.config.gasUrl ? '#047857' : '#60748c';

    $('activeCount').textContent = state.config.channels.filter((c) => c.state).length;
    const heights = [10, 16, 22, 28];
    $('miniLoadBars').innerHTML = state.config.channels
      .map((c, i) => `<div class="mini-bar ${c.state ? 'is-on' : ''}" style="height:${heights[i]}px;"></div>`)
      .join('');

    applyTheme();
    renderSoundButton();
    renderPowerAndSafety();
    renderChannels();
    renderLogs();
  }

  SCB.isAlarmActive = () => Boolean(alarmTimer);
  SCB.isSoundEnabled = () => soundEnabled;
  SCB.getWarmupSec = () => mq2WarmupSec;
  SCB.toast = toast;
  SCB.render = render;
  SCB.renderLogs = renderLogs;
  SCB.renderBillingTable = renderBillingTable;

  function bindEvents() {
    if ($('btnToggleTheme')) {
      $('btnToggleTheme').onclick = () => {
        currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
        localStorage.setItem(THEME_KEY, currentTheme);
        applyTheme();
        playSound('click');
      };
    }
    $('btnToggleSound').onclick = () => {
      soundEnabled = !soundEnabled;
      localStorage.setItem(SOUND_KEY, String(soundEnabled));
      renderSoundButton();
      if (!soundEnabled) syncAlarmLoop(false);
      else {
        playSound('click');
        renderPowerAndSafety();
      }
    };
    $('btnToggleMode').onclick = () => {
      state.config.mode = state.config.mode === 'SIMULATION' ? 'LIVE' : 'SIMULATION';
      state.power = { v: 0, c: 0, p: 0, e: 0, f: 0, pf: 0 };
      state.smoke = 0;
      state.simFault = null;
      if (state.config.mode === 'SIMULATION') state.isOnline = true;
      saveConfig();
      render();
      syncDevice();
    };
    $('btnManualSync').onclick = () => { playSound('click'); syncDevice(); };
    $('btnRetrySync').onclick = syncDevice;
    $('btnFetchCloudLogs').onclick = () => fetchCloudLogs(false);
    $('logFilter').onchange = renderLogs;

    $('btnResetCost').onclick = async () => {
      if (!confirm('ยืนยันบันทึกยอดและรีเซ็ตหน่วยไฟฟ้าสะสม (kWh) เป็น 0?')) return;
      try {
        await performEnergyReset('รีเซ็ตเอง', 'Web Dashboard');
        playSound('success');
        toast('บันทึกประวัติและรีเซ็ตหน่วยไฟฟ้าเป็น 0 แล้ว', 'success');
      } catch (e) { toast(e.message, 'error'); }
    };

    $('btnAllOn').onclick = async () => {
      if (!state.isOnline) return;
      try {
        if (state.config.mode === 'LIVE') await blynkBatch('V10=Web%20Dashboard&V4=1');
        state.config.channels.forEach((c) => { c.state = true; });
        playSound('click');
        pushLog('MASTER (V4)', 'เปิดทั้งหมด (ALL ON)');
        render();
      } catch (e) { toast(e.message, 'error'); }
    };

    $('btnAllOffPrompt').onclick = () => $('confirmModal').classList.remove('hidden');
    $('btnCancelConfirm').onclick = () => $('confirmModal').classList.add('hidden');
    $('btnConfirmAllOff').onclick = async () => {
      $('confirmModal').classList.add('hidden');
      if (!state.isOnline) return;
      try {
        if (state.config.mode === 'LIVE') await blynkBatch('V10=Web%20Dashboard&V4=0');
        state.config.channels.forEach((c) => { c.state = false; });
        playSound('click');
        pushLog('MASTER (V4)', 'ปิดทั้งหมด (ALL OFF)');
        render();
      } catch (e) { toast(e.message, 'error'); }
    };

    $('channelGrid').onclick = (e) => {
      const sw = e.target.closest('.ch-switch');
      if (sw && !sw.disabled) { playSound('click'); return toggleChannel(Number(sw.dataset.ch)); }
      const sc = e.target.closest('.ch-sched');
      if (sc) {
        state.activeSchedId = Number(sc.dataset.sched);
        const ch = state.config.channels.find((c) => c.id === state.activeSchedId);
        $('schedModalTitle').textContent = `ตั้งเวลา (${ch.schedPin}): ${ch.name}`;
        $('schedStart').value = ch.schedule?.start || '';
        $('schedStop').value = ch.schedule?.stop || '';
        const days = String(ch.schedule?.days || '');
        document.querySelectorAll('#weekdaySelector input').forEach((cb) => {
          cb.checked = !days || days.includes(cb.value);
        });
        playSound('click');
        $('scheduleModal').classList.remove('hidden');
      }
    };

    $('btnCloseSchedX').onclick = () => $('scheduleModal').classList.add('hidden');
    $('btnCancelSched').onclick = () => $('scheduleModal').classList.add('hidden');
    $('btnClearSchedule').onclick = async () => {
      playSound('click');
      await saveSchedule('', '', '');
      playSound('success');
    };
    $('btnSaveSchedule').onclick = async () => {
      const st = $('schedStart').value;
      const sp = $('schedStop').value;
      const days = [...document.querySelectorAll('#weekdaySelector input:checked')].map((c) => c.value).join(',');
      if (!st && !sp) { playSound('error'); return toast('กรุณาระบุเวลาอย่างน้อย 1 ช่อง', 'error'); }
      if (!days) { playSound('error'); return toast('กรุณาเลือกวันทำงาน', 'error'); }
      await saveSchedule(st, sp, days);
      playSound('success');
    };

    $('btnOpenSettings').onclick = () => {
      $('cfgServer').value = state.config.server;
      $('cfgToken').value = state.config.token;
      $('cfgRate').value = state.config.rate;
      $('cfgMaxVolt').value = state.config.maxVolt;
      $('cfgMaxAmp').value = state.config.maxAmp;
      $('cfgMaxSmoke').value = state.config.maxSmoke;
      $('cfgGasUrl').value = state.config.gasUrl || '';
      $('cfgResetCycle').value = String(state.config.resetCycleDays || 0);
      $('channelConfigInputs').innerHTML = state.config.channels.map((ch) => `
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="mono" style="color:var(--text-muted);width:26px;">0${ch.id}</span>
          <input id="cfgName_${ch.id}" type="text" value="${esc(ch.name)}" class="input" />
        </div>
      `).join('');
      playSound('click');
      $('settingsModal').classList.remove('hidden');
    };
    $('btnCloseSettingsX').onclick = () => $('settingsModal').classList.add('hidden');
    $('btnCancelSettings').onclick = () => $('settingsModal').classList.add('hidden');
    $('btnSaveSettings').onclick = async () => {
      const prevV = state.config.maxVolt;
      const prevA = state.config.maxAmp;
      const prevS = state.config.maxSmoke;

      state.config.server = $('cfgServer').value.trim() || 'blynk.cloud';
      state.config.token = $('cfgToken').value.trim();
      state.config.rate = parseFloat($('cfgRate').value) || 4.5;
      state.config.gasUrl = $('cfgGasUrl').value.trim();

      const clamped = clampSafetyThresholds({
        maxVolt: $('cfgMaxVolt').value,
        maxAmp: $('cfgMaxAmp').value,
        maxSmoke: $('cfgMaxSmoke').value,
      });
      Object.assign(state.config, clamped);

      const newCycle = parseInt($('cfgResetCycle').value, 10) || 0;
      if (newCycle !== state.config.resetCycleDays) {
        state.config.resetCycleDays = newCycle;
        state.config.lastEnergyResetAt = new Date().toISOString();
      }
      state.config.channels.forEach((ch) => {
        const v = $(`cfgName_${ch.id}`).value.trim();
        if (v) ch.name = v;
      });
      saveConfig();
      $('settingsModal').classList.add('hidden');

      const changed = prevV !== clamped.maxVolt || prevA !== clamped.maxAmp || prevS !== clamped.maxSmoke;
      await syncSettingsToCloud(changed);
      playSound('success');
      toast('บันทึกการตั้งค่าและเกณฑ์ปลอดภัยแล้ว', 'success');
      render();
      syncDevice();
      fetchCloudLogs(true);
      fetchBillingHistory(true);
    };

    $('btnOpenBilling').onclick = () => {
      renderBillingTable();
      $('billingModal').classList.remove('hidden');
      fetchBillingHistory(true);
    };
    $('btnCloseBillingX').onclick = () => $('billingModal').classList.add('hidden');
    $('btnCloseBilling').onclick = () => $('billingModal').classList.add('hidden');
    $('btnClearBilling').onclick = () => {
      if (!confirm('ยืนยันล้างประวัติบิลในเครื่องทั้งหมด?')) return;
      state.billingHistory = [];
      saveBilling();
      renderBillingTable();
      toast('ล้างประวัติบิลแล้ว', 'info');
    };

    // System Test Bench (SIMULATION mode)
    $('btnTestOverVolt').onclick = () => {
      state.simFault = 'OVER_VOLT';
      state.config.channels.forEach((c) => { c.state = false; });
      state.power.v = state.config.maxVolt + 6.5;
      pushLog('SAFETY TEST', `จำลองแรงดันเกิน ${state.power.v.toFixed(1)}V → ตัดไฟทั้งหมด`, 'Safety');
      toast('จำลองแรงดันเกินพิกัดและตัดไฟอัตโนมัติแล้ว', 'error');
      render();
    };

    $('btnTestOverAmp').onclick = () => {
      state.simFault = 'OVER_AMP';
      state.config.channels.forEach((c) => { c.state = false; });
      state.power.c = state.config.maxAmp + 1.25;
      state.power.p = state.power.v * state.power.c * 0.98;
      pushLog('SAFETY TEST', `จำลองกระแสเกิน ${state.power.c.toFixed(2)}A → ตัดไฟทั้งหมด`, 'Safety');
      toast('จำลองกระแสเกินพิกัดและตัดไฟอัตโนมัติแล้ว', 'error');
      render();
    };

    if ($('btnCloseEmergency')) {
      $('btnCloseEmergency').onclick = () => {
        const { v, c } = state.power;
        const { maxVolt, maxAmp, maxSmoke } = clampSafetyThresholds(state.config);
        ackFaultKey = (state.smoke >= maxSmoke && mq2WarmupSec <= 0) ? 'SMOKE' : (v >= maxVolt) ? 'OVER_VOLT' : (c >= maxAmp) ? 'OVER_AMP' : 'ANY';
        $('emergencyModal').classList.add('hidden');
      };
    }
    if ($('btnSilenceAlarm')) {
      $('btnSilenceAlarm').onclick = () => {
        soundEnabled = false;
        localStorage.setItem(SOUND_KEY, 'false');
        syncAlarmLoop(false);
        renderSoundButton();
        toast('ปิดเสียงไซเรนแล้ว', 'info');
      };
    }
    if ($('btnEmergencyReset')) {
      $('btnEmergencyReset').onclick = () => {
        if ($('btnTestReset')) $('btnTestReset').click();
      };
    }
    if ($('btnTestWarmup')) {
      $('btnTestWarmup').onclick = () => {
        state.simFault = null;
        startMq2Warmup(60);
        toast('เริ่มนับถอยหลังอุ่นเซนเซอร์ MQ-2 (60 วินาที)', 'info');
        render();
      };
    }
    $('btnTestSmoke').onclick = () => {
      startMq2Warmup(0);
      state.simFault = 'SMOKE';
      state.config.channels.forEach((c) => { c.state = false; });
      state.smoke = Math.min(95, state.config.maxSmoke + 15);
      pushLog('SAFETY TEST', `จำลองตรวจพบควัน ${state.smoke}% (MQ-2) → ตัดไฟทั้งหมด`, 'Safety');
      toast('จำลองตรวจพบควัน MQ-2 และตัดไฟอัตโนมัติแล้ว', 'error');
      render();
    };

    $('btnTestReset').onclick = () => {
      startMq2Warmup(0);
      ackFaultKey = null;
      state.simFault = null;
      state.smoke = 8;
      state.power.v = 0;
      state.power.c = 0;
      state.power.p = 0;
      recordPowerHistory(0);
      playSound('success');
      toast('รีเซ็ตสถานะระบบกลับสู่ปกติแล้ว', 'success');
      render();
    };

    $('btnTestSeq').onclick = async () => {
      if (state.isTestingSeq) return;
      state.isTestingSeq = true;
      state.simFault = null;
      toast('เริ่มทดสอบรีเลย์เรียงช่อง 1 → 4...', 'info');
      for (let i = 0; i < state.config.channels.length; i += 1) {
        state.config.channels.forEach((c, idx) => { c.state = idx === i; });
        render();
        await new Promise((r) => setTimeout(r, 450));
      }
      state.config.channels.forEach((c) => { c.state = false; });
      state.isTestingSeq = false;
      pushLog('SYSTEM TEST', 'ทดสอบรีเลย์ครบทั้ง 4 ช่อง (ผ่าน)');
      toast('ทดสอบรีเลย์ 1 → 4 ผ่านครบทุกช่อง', 'success');
      render();
    };
  }

  function runIntroChoreography() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!Element.prototype.animate) return;
    const COUT = 'cubic-bezier(.33, 1, .68, 1)';

    document.querySelectorAll('#channelGrid .ch-card').forEach((card, idx) => {
      card.animate([{ transform: 'translateY(14px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 420, delay: 180 + idx * 65, easing: COUT, fill: 'both' });
    });
  }

  function start() {
    bindEvents();
    render();
    runIntroChoreography();
    syncDevice();
    fetchCloudConfig(true);
    fetchCloudLogs(true);
    fetchBillingHistory(true);
    setInterval(syncDevice, 4000);
    setInterval(() => fetchCloudLogs(true), 10000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window.SCB);
