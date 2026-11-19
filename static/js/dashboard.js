// dashboard.js - Control-Room Supervisory Dashboard Client Engine

(function() {
  'use strict';

  // --- STATE ---
  let isPaused = false;
  let audioEnabled = false;
  let audioCtx = null;
  let pollInterval = null;
  let lastDataTime = '--:--:--';
  let acknowledgedAlarms = new Set();
  let currentTrendMetric = 'moisture'; // 'moisture' | 'production'
  let currentTrendRange = 'live';      // 'live' | 'daily' | 'custom'
  let currentBinFilter = 'all';        // 'all' | 'alert'
  let lastTagState = null;
  let trendDataCache = [];

  // Interactive chart state
  let chartBaseStart = null;
  let chartBaseEnd = null;
  let chartViewStart = null;
  let chartViewEnd = null;
  let chartPinnedPoint = null;

  let chartDragging = false;
  let chartPanning = false;
  let chartDragStartX = 0;
  let chartDragCurrentX = 0;
  let chartPanOriginalStart = null;
  let chartPanOriginalEnd = null;

  // Five-minute gap = break line instead of implying continuous data
  const TREND_GAP_MS = 5 * 60 * 1000;

  // --- DOM ELEMENTS ---
  const beacon = document.getElementById('system-beacon');
  const statusText = document.getElementById('system-status-text');
  const latencyText = document.getElementById('cycle-latency');
  const pauseBanner = document.getElementById('pause-banner');
  const pauseTime = document.getElementById('pause-timestamp');
  const alarmBanner = document.getElementById('alarm-banner');
  const alarmList = document.getElementById('alarm-list');
  const btnAckAlarms = document.getElementById('btn-ack-alarms');

  // Controls
  const btnPause = document.getElementById('btn-pause');
  const iconPause = document.getElementById('icon-pause');
  const iconPlay = document.getElementById('icon-play');
  const labelPause = document.getElementById('label-pause');
  const btnAudio = document.getElementById('btn-audio');
  const iconAudioOff = document.getElementById('icon-audio-off');
  const iconAudioOn = document.getElementById('icon-audio-on');
  const btnPrint = document.getElementById('btn-print');
  const btnTheme = document.getElementById('btn-theme');
  const iconSun = document.getElementById('icon-sun');
  const iconMoon = document.getElementById('icon-moon');
  const btnFullscreen = document.getElementById('btn-fullscreen');
  const btnAdmin = document.getElementById('btn-admin');

  // KPIs
  const valProd = document.getElementById('val-prod');
  const valProdTarget = document.getElementById('val-prod-target');
  const barProd = document.getElementById('bar-prod');
  const pctProd = document.getElementById('pct-prod');
  const pillProd = document.getElementById('pill-prod');

  const valGp3 = document.getElementById('val-gp3');
  const valGp3Sp = document.getElementById('val-gp3-sp');
  const valGp3Dev = document.getElementById('val-gp3-dev');
  const pillGp3 = document.getElementById('pill-gp3');

  const valTg = document.getElementById('val-tg');
  const pillTg = document.getElementById('pill-tg');

  const valMoist = document.getElementById('val-moist');
  const pillMoist = document.getElementById('pill-moist');
  const moistGaugeMarker = document.getElementById('moist-gauge-marker');

  // Slim Cards
  const valVariance = document.getElementById('val-variance');
  const valAvgBin = document.getElementById('val-avg-bin');
  const labelAvgBinCount = document.getElementById('label-avg-bin-count');
  const cardStarvation = document.getElementById('card-starvation');
  const valStarvation = document.getElementById('val-starvation');

  // Bin Filter
  const btnFilterAll = document.getElementById('btn-filter-all');
  const btnFilterAlert = document.getElementById('btn-filter-alert');
  const countBinAlert = document.getElementById('count-bin-alert');

  // Trend Controls
  const tabMoisture = document.getElementById('tab-moisture');
  const tabProduction = document.getElementById('tab-production');
  const rangeBtns = document.querySelectorAll('.btn-range');
  const customRangeBar = document.getElementById('custom-range-bar');
  const inputFrom = document.getElementById('input-range-from');
  const inputTo = document.getElementById('input-range-to');
  const btnApplyRange = document.getElementById('btn-apply-range');
  const trendSvg = document.getElementById('trend-svg');
  const chartTooltip = document.getElementById('chart-tooltip');

  // Admin Modal
  const adminModal = document.getElementById('admin-modal');
  const btnModalClose = document.getElementById('btn-modal-close');
  const stepLogin = document.getElementById('modal-step-login');
  const stepConfig = document.getElementById('modal-step-config');
  const adminPwd = document.getElementById('admin-pwd');
  const btnAdminLogin = document.getElementById('btn-admin-login');
  const loginFeedback = document.getElementById('login-feedback');
  const configFeedback = document.getElementById('config-feedback');
  const btnAdminLogout = document.getElementById('btn-admin-logout');
  const btnResetDefaults = document.getElementById('btn-reset-defaults');
  const btnSaveConfig = document.getElementById('btn-save-config');
  const btnTestDb = document.getElementById('btn-test-db');
  const dbTestResult = document.getElementById('db-test-result');

  // --- AUDIO SYNTHESIZER ---
  function playAlarmBeep() {
    if (!audioEnabled) return;

    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }

      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);

      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        audioCtx.currentTime + 0.35
      );

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start();
      osc.stop(audioCtx.currentTime + 0.35);

    } catch (e) {
      console.warn('Audio alert error:', e);
    }
  }

  // --- THEME MANAGEMENT ---
  function initTheme() {
    const current =
      document.documentElement.getAttribute('data-theme') || 'dark';

    updateThemeIcons(current);
  }

  function toggleTheme() {
    const current =
      document.documentElement.getAttribute('data-theme') || 'dark';

    const next =
      current === 'dark' ? 'light' : 'dark';

    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('dashboard_theme', next);

    updateThemeIcons(next);
    renderTrendChart();
  }

  function updateThemeIcons(theme) {
    if (theme === 'dark') {
      iconSun.classList.remove('hidden');
      iconMoon.classList.add('hidden');
    } else {
      iconSun.classList.add('hidden');
      iconMoon.classList.remove('hidden');
    }
  }

  // --- FULLSCREEN & PRINT ---
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        console.warn(`Fullscreen request failed: ${err.message}`);
      });
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  }

  // --- UI POLLER & DATA FETCHING ---
  async function fetchTags() {
    if (isPaused) return;

    try {
      const res = await fetch('/api/tags');

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();

      lastTagState = data;
      renderDashboard(data);

    } catch (err) {
      console.error('Fetch error:', err);

      renderStatus(
        'DATA_UNAVAILABLE',
        '--:--:--',
        0
      );
    }
  }

  function renderStatus(status, serverTime, latencyMs) {
    beacon.className = 'beacon';

    if (status === 'LIVE') {
      beacon.classList.add('beacon-live');
      statusText.textContent = `Updated ${serverTime}`;

    } else if (status === 'STALE') {
      beacon.classList.add('beacon-warn');
      statusText.textContent = 'STALE';

    } else if (status === 'DATA_UNAVAILABLE') {
      beacon.classList.add('beacon-crit');
      statusText.textContent = 'DATA UNAVAILABLE';

    } else {
      statusText.textContent = 'STANDBY / CONNECTING';
    }

    latencyText.textContent =
      latencyMs > 0
        ? `(${latencyMs}ms)`
        : '';
  }

  function renderDashboard(data) {
    lastDataTime = data.server_time_ist;

    renderStatus(
      data.status,
      data.server_time_ist,
      data.cycle_ms
    );

    // 1. Alarms & Audio
    renderAlarms(data.alarms);

    // 2. Row 1 KPIs
    const k = data.kpis;

    // Production
    if (k.production) {
      valProd.textContent =
        k.production.value !== null
          ? Number(k.production.value).toLocaleString('en-IN')
          : '--';

      valProdTarget.textContent =
        Number(k.production.target).toLocaleString('en-IN');

      pctProd.textContent =
        `${k.production.pct}%`;

      barProd.style.width =
        `${Math.min(100, Math.max(0, k.production.pct))}%`;

      barProd.className =
        `progress-bar bar-${k.production.color}`;

      updatePill(
        pillProd,
        k.production.quality
      );
    }

    // GP-3
    if (k.gp3) {
      valGp3.textContent =
        k.gp3.value !== null
          ? k.gp3.value.toFixed(1)
          : '--';

      valGp3Sp.textContent =
        k.gp3.setpoint;

      if (
        k.gp3.deviation !== null &&
        k.gp3.deviation !== undefined
      ) {
        valGp3Dev.textContent =
          `${k.gp3.deviation > 0 ? '+' : ''}${k.gp3.deviation} TPH`;
      } else {
        valGp3Dev.textContent = '--';
      }

      updatePill(
        pillGp3,
        k.gp3.quality
      );
    }

    // TG
    if (k.tg) {
      valTg.textContent =
        k.tg.value !== null
          ? k.tg.value.toFixed(1)
          : '--';

      updatePill(
        pillTg,
        k.tg.quality
      );
    }

    // Moisture
    if (k.moisture) {
      valMoist.textContent =
        k.moisture.value !== null
          ? k.moisture.value.toFixed(2)
          : '--';

      valMoist.style.color =
        getStatusColor(k.moisture.color);

      updatePill(
        pillMoist,
        k.moisture.quality
      );

      if (
        k.moisture.value !== null &&
        k.moisture.quality === 'GOOD'
      ) {
        const markerPct =
          Math.min(
            100,
            Math.max(
              0,
              (k.moisture.value / 15.0) * 100
            )
          );

        moistGaugeMarker.style.left =
          `${markerPct}%`;

        moistGaugeMarker.style.display =
          'block';

      } else {
        moistGaugeMarker.style.display =
          'none';
      }
    }

    // 3. Row 2 Slim Cards
    if (k.variance) {
      if (
        k.variance.value !== null &&
        k.variance.quality === 'GOOD'
      ) {
        const v = k.variance.value;

        valVariance.textContent =
          `${v > 0 ? '+' : ''}${v.toFixed(1)}`;

        valVariance.style.color =
          getStatusColor(k.variance.color);

      } else {
        valVariance.textContent = '--';

        valVariance.style.color =
          'var(--text-muted)';
      }
    }

    if (k.avg_bin) {
      valAvgBin.textContent =
        k.avg_bin.value !== null
          ? k.avg_bin.value.toFixed(1)
          : '--';

      labelAvgBinCount.textContent =
        `(${k.avg_bin.good_count} of 11 reporting)`;
    }

    if (k.starvation_count !== undefined) {
      if (k.starvation_count > 0) {
        cardStarvation.classList.add(
          'critical-starvation'
        );

        valStarvation.textContent =
          `${k.starvation_count} Bin${k.starvation_count > 1 ? 's' : ''} Critical`;

      } else {
        cardStarvation.classList.remove(
          'critical-starvation'
        );

        valStarvation.textContent =
          'All Bins OK';
      }
    }

    // 4. Row 3 Bins
    let alertBinCount = 0;

    const binLetters =
      ['B','C','D','E','F','G','H','I','J','K','L'];

    binLetters.forEach(b => {
      const bData = data.bins[b];

      const col =
        document.querySelector(
          `.vessel-col[data-bin="${b}"]`
        );

      if (!col || !bData) return;

      const fill =
        document.getElementById(
          `fill-bin-${b}`
        );

      const pct =
        document.getElementById(
          `pct-bin-${b}`
        );

      const badge =
        document.getElementById(
          `badge-bin-${b}`
        );

      const tube =
        col.querySelector('.vessel-tube');

      const isAlert =
        (
          bData.state === 'STARVING' ||
          bData.state === 'OVERFEED'
        );

      if (isAlert) {
        alertBinCount++;
      }

      if (
        currentBinFilter === 'alert' &&
        !isAlert
      ) {
        col.style.display = 'none';
      } else {
        col.style.display = 'flex';
      }

      if (
        bData.quality === 'GOOD' &&
        bData.value !== null
      ) {
        const valClamped =
          Math.min(
            100,
            Math.max(0, bData.value)
          );

        fill.style.height =
          `${valClamped}%`;

        fill.className =
          `vessel-fill fill-${bData.color}`;

        pct.textContent =
          `${bData.value.toFixed(1)}%`;

      } else {
        fill.style.height = '0%';
        fill.className = 'vessel-fill fill-grey';
        pct.textContent = '--%';
      }

      if (bData.state === 'STARVING') {
        tube.classList.add('glow-red');
        badge.textContent = 'STARV';
        badge.classList.remove('hidden');

      } else if (bData.state === 'OVERFEED') {
        tube.classList.add('glow-red');
        badge.textContent = 'OVERFEED';
        badge.classList.remove('hidden');

      } else {
        tube.classList.remove('glow-red');
        badge.classList.add('hidden');
      }
    });

    countBinAlert.textContent =
      alertBinCount;
  }

  function updatePill(pillEl, quality) {
    if (!pillEl) return;

    pillEl.className = 'status-pill';

    if (quality === 'GOOD') {
      pillEl.classList.add('pill-good');
      pillEl.textContent = 'GOOD';

    } else if (quality === 'STALE') {
      pillEl.classList.add('pill-stale');
      pillEl.textContent = 'STALE';

    } else {
      pillEl.classList.add('pill-crit');
      pillEl.textContent = 'BAD';
    }
  }

  function getStatusColor(colorName) {
    switch(colorName) {
      case 'green':
        return 'var(--state-ok)';

      case 'yellow':
        return 'var(--state-warn)';

      case 'red':
        return 'var(--state-crit)';

      default:
        return 'var(--text-muted)';
    }
  }

  // --- ALARMS & ACKNOWLEDGEMENT ---
  function renderAlarms(alarms) {
    if (
      !alarms ||
      alarms.length === 0
    ) {
      alarmBanner.classList.add('hidden');
      alarmList.innerHTML = '';
      acknowledgedAlarms.clear();
      return;
    }

    alarmList.innerHTML = '';

    let hasUnacknowledged = false;

    alarms.forEach(alm => {
      const span =
        document.createElement('span');

      span.textContent = alm;

      alarmList.appendChild(span);

      if (!acknowledgedAlarms.has(alm)) {
        hasUnacknowledged = true;
      }
    });

    alarmBanner.classList.remove('hidden');

    if (hasUnacknowledged) {
      alarmBanner.style.animation =
        'border-pulse 1.5s infinite';

      playAlarmBeep();

    } else {
      alarmBanner.style.animation = 'none';
    }
  }

  btnAckAlarms.addEventListener('click', () => {
    if (
      lastTagState &&
      lastTagState.alarms
    ) {
      lastTagState.alarms.forEach(
        a => acknowledgedAlarms.add(a)
      );

      alarmBanner.style.animation =
        'none';
    }
  });


  // =========================================================================
  // INTERACTIVE TREND CHART
  // =========================================================================

  function parseTrendTime(ts) {
    const t =
      new Date(ts).getTime();

    return Number.isFinite(t)
      ? t
      : NaN;
  }


  async function fetchTrendData() {
    try {
      let url =
        `/api/trend?metric=${currentTrendMetric}&range=${currentTrendRange}`;


      if (currentTrendRange === 'custom') {
        if (
          !inputFrom.value ||
          !inputTo.value
        ) {
          console.warn(
            'Select both From and To date/time.'
          );

          return;
        }


        const fromDate =
          new Date(inputFrom.value);


        const toDate =
          new Date(inputTo.value);


        if (
          Number.isNaN(fromDate.getTime()) ||
          Number.isNaN(toDate.getTime())
        ) {
          console.warn(
            'Invalid custom trend range.'
          );

          return;
        }


        if (fromDate >= toDate) {
          console.warn(
            'From date/time must be before To date/time.'
          );

          return;
        }


        url +=
          `&from=${encodeURIComponent(fromDate.toISOString())}` +
          `&to=${encodeURIComponent(toDate.toISOString())}`;
      }


      const res =
        await fetch(url);


      if (!res.ok) {
        throw new Error(
          `HTTP ${res.status}`
        );
      }


      const data =
        await res.json();


      trendDataCache =
        Array.isArray(data)
          ? data
          : [];


      trendDataCache =
        trendDataCache

          .filter(pt => {
            if (!pt) return false;

            const t =
              parseTrendTime(pt.ts);

            const value =
              Number(pt.value);

            return (
              Number.isFinite(t) &&
              Number.isFinite(value)
            );
          })

          .map(pt => ({
            ts: pt.ts,
            value: Number(pt.value)
          }))

          .sort(
            (a, b) =>
              parseTrendTime(a.ts) -
              parseTrendTime(b.ts)
          );


      resetChartView(false);

      renderTrendChart();


    } catch (e) {
      console.warn(
        'Trend fetch error:',
        e
      );
    }
  }


  function getChartBaseRange() {

    // DAILY 22:00 IST -> 22:00 IST
    if (currentTrendRange === 'daily') {

      const now =
        new Date();


      const IST_OFFSET_MS =
        330 * 60 * 1000;


      const istClock =
        new Date(
          now.getTime() +
          IST_OFFSET_MS
        );


      const year =
        istClock.getUTCFullYear();


      const month =
        istClock.getUTCMonth();


      let day =
        istClock.getUTCDate();


      const hour =
        istClock.getUTCHours();


      if (hour < 22) {
        day -= 1;
      }


      // 22:00 IST = 16:30 UTC
      const start =
        Date.UTC(
          year,
          month,
          day,
          16,
          30,
          0,
          0
        );


      return {
        start: start,
        end:
          start +
          24 *
          60 *
          60 *
          1000
      };
    }


    // CUSTOM
    if (
      currentTrendRange === 'custom' &&
      inputFrom.value &&
      inputTo.value
    ) {
      const start =
        new Date(
          inputFrom.value
        ).getTime();


      const end =
        new Date(
          inputTo.value
        ).getTime();


      if (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        end > start
      ) {
        return {
          start: start,
          end: end
        };
      }
    }


    // LIVE
    if (
      trendDataCache &&
      trendDataCache.length > 0
    ) {
      const first =
        parseTrendTime(
          trendDataCache[0].ts
        );


      const last =
        parseTrendTime(
          trendDataCache[
            trendDataCache.length - 1
          ].ts
        );


      if (
        Number.isFinite(first) &&
        Number.isFinite(last)
      ) {
        if (first === last) {
          return {
            start:
              first - 30000,

            end:
              last + 30000
          };
        }


        return {
          start: first,
          end: last
        };
      }
    }


    return {
      start:
        Date.now() - 60000,

      end:
        Date.now()
    };
  }


  function resetChartView(render = true) {
    const base =
      getChartBaseRange();


    chartBaseStart =
      base.start;


    chartBaseEnd =
      base.end;


    chartViewStart =
      base.start;


    chartViewEnd =
      base.end;


    chartPinnedPoint =
      null;


    chartDragging =
      false;


    chartPanning =
      false;


    if (render) {
      renderTrendChart();
    }
  }


  function getShiftForTime(timeMs) {
    const date =
      new Date(timeMs);


    const hourString =
      date.toLocaleTimeString(
        'en-GB',
        {
          timeZone:
            'Asia/Kolkata',

          hour:
            '2-digit',

          hour12:
            false
        }
      );


    const hour =
      parseInt(
        hourString,
        10
      );


    if (
      hour >= 6 &&
      hour < 14
    ) {
      return 'A';
    }


    if (
      hour >= 14 &&
      hour < 22
    ) {
      return 'B';
    }


    return 'C';
  }


  function formatChartAxisTime(
    timeMs,
    spanMs
  ) {
    const date =
      new Date(timeMs);


    const hours =
      spanMs /
      (
        60 *
        60 *
        1000
      );


    if (hours <= 24) {
      return date.toLocaleTimeString(
        'en-IN',
        {
          timeZone:
            'Asia/Kolkata',

          hour:
            '2-digit',

          minute:
            '2-digit',

          hour12:
            false
        }
      );
    }


    if (hours <= 24 * 7) {
      const datePart =
        date.toLocaleDateString(
          'en-IN',
          {
            timeZone:
              'Asia/Kolkata',

            day:
              '2-digit',

            month:
              'short'
          }
        );


      const timePart =
        date.toLocaleTimeString(
          'en-IN',
          {
            timeZone:
              'Asia/Kolkata',

            hour:
              '2-digit',

            minute:
              '2-digit',

            hour12:
              false
          }
        );


      return `${datePart} ${timePart}`;
    }


    return date.toLocaleDateString(
      'en-IN',
      {
        timeZone:
          'Asia/Kolkata',

        day:
          '2-digit',

        month:
          'short'
      }
    );
  }


  function createSvgRect(
    x,
    y,
    w,
    h,
    fill
  ) {
    const el =
      document.createElementNS(
        'http://www.w3.org/2000/svg',
        'rect'
      );


    el.setAttribute('x', x);
    el.setAttribute('y', y);

    el.setAttribute(
      'width',
      Math.max(0, w)
    );

    el.setAttribute(
      'height',
      Math.max(0, h)
    );

    el.setAttribute(
      'fill',
      fill
    );


    return el;
  }


  function createSvgLine(
    x1,
    y1,
    x2,
    y2,
    stroke,
    width,
    dash = ''
  ) {
    const el =
      document.createElementNS(
        'http://www.w3.org/2000/svg',
        'line'
      );


    el.setAttribute(
      'x1',
      x1
    );

    el.setAttribute(
      'y1',
      y1
    );

    el.setAttribute(
      'x2',
      x2
    );

    el.setAttribute(
      'y2',
      y2
    );

    el.setAttribute(
      'stroke',
      stroke
    );

    el.setAttribute(
      'stroke-width',
      width
    );


    if (dash) {
      el.setAttribute(
        'stroke-dasharray',
        dash
      );
    }


    return el;
  }


  function createSvgText(
    x,
    y,
    content,
    anchor = 'start'
  ) {
    const el =
      document.createElementNS(
        'http://www.w3.org/2000/svg',
        'text'
      );


    el.setAttribute(
      'x',
      x
    );

    el.setAttribute(
      'y',
      y
    );

    el.setAttribute(
      'text-anchor',
      anchor
    );

    el.textContent =
      content;


    return el;
  }


  function createSvgCircle(
    x,
    y,
    radius,
    fill,
    stroke = 'none',
    strokeWidth = 0
  ) {
    const el =
      document.createElementNS(
        'http://www.w3.org/2000/svg',
        'circle'
      );


    el.setAttribute(
      'cx',
      x
    );

    el.setAttribute(
      'cy',
      y
    );

    el.setAttribute(
      'r',
      radius
    );

    el.setAttribute(
      'fill',
      fill
    );

    el.setAttribute(
      'stroke',
      stroke
    );

    el.setAttribute(
      'stroke-width',
      strokeWidth
    );


    return el;
  }


  function renderTrendChart() {
    if (!trendSvg) return;


    trendSvg.innerHTML = '';


    const rect =
      trendSvg.getBoundingClientRect();


    const width =
      rect.width || 600;


    const height =
      rect.height || 220;


    const padLeft = 52;
    const padRight = 18;
    const padTop = 32;
    const padBottom = 30;


    const chartW =
      width -
      padLeft -
      padRight;


    const chartH =
      height -
      padTop -
      padBottom;


    if (
      chartW <= 0 ||
      chartH <= 0
    ) {
      return;
    }


    // BASE RANGE
    const base =
      getChartBaseRange();


    chartBaseStart =
      base.start;


    chartBaseEnd =
      base.end;


    if (
      !Number.isFinite(chartViewStart) ||
      !Number.isFinite(chartViewEnd)
    ) {
      chartViewStart =
        chartBaseStart;

      chartViewEnd =
        chartBaseEnd;
    }


    chartViewStart =
      Math.max(
        chartBaseStart,
        chartViewStart
      );


    chartViewEnd =
      Math.min(
        chartBaseEnd,
        chartViewEnd
      );


    if (
      chartViewEnd <=
      chartViewStart
    ) {
      chartViewStart =
        chartBaseStart;

      chartViewEnd =
        chartBaseEnd;
    }


    const timeSpan =
      Math.max(
        1,
        chartViewEnd -
        chartViewStart
      );


    // VISIBLE DATA
    const visibleData =
      trendDataCache.filter(
        point => {
          const t =
            parseTrendTime(
              point.ts
            );


          return (
            Number.isFinite(t) &&
            t >= chartViewStart &&
            t <= chartViewEnd
          );
        }
      );


    // Y RANGE
    let minY = 0;
    let maxY = 15;
    let productionTarget = 16000;


    if (
      currentTrendMetric ===
      'production'
    ) {
      if (
        lastTagState &&
        lastTagState.thresholds
      ) {
        productionTarget =
          Number(
            lastTagState
              .thresholds
              .day_production_target_mt
          ) || 16000;
      }


      const values =
        visibleData
          .map(
            point =>
              Number(
                point.value
              )
          )
          .filter(
            value =>
              Number.isFinite(value)
          );


      const actualMax =
        values.length > 0
          ? Math.max(...values)
          : 0;


      maxY =
        Math.max(
          productionTarget,
          actualMax > 0
            ? actualMax * 1.05
            : productionTarget
        );


      if (
        !Number.isFinite(maxY) ||
        maxY <= 0
      ) {
        maxY =
          productionTarget ||
          16000;
      }
    }


    const getX =
      input => {
        const t =
          typeof input === 'number'
            ? input
            : parseTrendTime(input);


        if (!Number.isFinite(t)) {
          return padLeft;
        }


        return (
          padLeft +
          (
            (
              t -
              chartViewStart
            ) /
            timeSpan
          ) *
          chartW
        );
      };


    const getY =
      input => {
        const numeric =
          Number(input);


        const value =
          Number.isFinite(numeric)
            ? numeric
            : minY;


        const safe =
          Math.min(
            maxY,
            Math.max(
              minY,
              value
            )
          );


        const denominator =
          Math.max(
            0.000001,
            maxY -
            minY
          );


        return (
          padTop +
          chartH -
          (
            (
              safe -
              minY
            ) /
            denominator
          ) *
          chartH
        );
      };


    // DAILY SHIFT BACKGROUNDS
    if (
      currentTrendRange ===
      'daily'
    ) {
      const eightHours =
        8 *
        60 *
        60 *
        1000;


      const shifts = [
        {
          start:
            chartBaseStart,

          end:
            chartBaseStart +
            eightHours,

          label:
            'SHIFT C'
        },

        {
          start:
            chartBaseStart +
            eightHours,

          end:
            chartBaseStart +
            2 *
            eightHours,

          label:
            'SHIFT A'
        },

        {
          start:
            chartBaseStart +
            2 *
            eightHours,

          end:
            chartBaseEnd,

          label:
            'SHIFT B'
        }
      ];


      shifts.forEach(
        (shift, index) => {
          const start =
            Math.max(
              shift.start,
              chartViewStart
            );


          const end =
            Math.min(
              shift.end,
              chartViewEnd
            );


          if (end <= start) {
            return;
          }


          const x1 =
            getX(start);


          const x2 =
            getX(end);


          trendSvg.appendChild(
            createSvgRect(
              x1,
              padTop,
              x2 - x1,
              chartH,
              index % 2 === 0
                ? 'rgba(148,163,184,0.025)'
                : 'rgba(148,163,184,0.055)'
            )
          );


          const label =
            createSvgText(
              (x1 + x2) / 2,
              padTop - 8,
              shift.label,
              'middle'
            );


          label.setAttribute(
            'fill',
            'var(--text-muted)'
          );

          label.setAttribute(
            'font-size',
            '8'
          );


          trendSvg.appendChild(
            label
          );
        }
      );
    }


    // MOISTURE BACKGROUND ZONES
    if (
      currentTrendMetric ===
      'moisture'
    ) {
      const y10 =
        getY(10);


      const y115 =
        getY(11.5);


      const yTop =
        getY(15);


      const y0 =
        getY(0);


      trendSvg.appendChild(
        createSvgRect(
          padLeft,
          y10,
          chartW,
          y0 - y10,
          'rgba(16,185,129,0.06)'
        )
      );


      trendSvg.appendChild(
        createSvgRect(
          padLeft,
          y115,
          chartW,
          y10 - y115,
          'rgba(245,158,11,0.06)'
        )
      );


      trendSvg.appendChild(
        createSvgRect(
          padLeft,
          yTop,
          chartW,
          y115 - yTop,
          'rgba(239,68,68,0.06)'
        )
      );
    }


    // Y GRID
    const ySteps = 4;


    for (
      let i = 0;
      i <= ySteps;
      i++
    ) {
      const value =
        minY +
        (
          i /
          ySteps
        ) *
        (
          maxY -
          minY
        );


      const y =
        getY(value);


      trendSvg.appendChild(
        createSvgLine(
          padLeft,
          y,
          padLeft + chartW,
          y,
          'var(--border-color)',
          1,
          '2,2'
        )
      );


      const display =
        currentTrendMetric ===
        'production'
          ? Math.round(value)
              .toLocaleString('en-IN')
          : value.toFixed(1);


      const label =
        createSvgText(
          padLeft - 8,
          y + 3,
          display,
          'end'
        );


      label.setAttribute(
        'fill',
        'var(--text-muted)'
      );

      label.setAttribute(
        'font-size',
        '9'
      );


      trendSvg.appendChild(
        label
      );
    }


    // MOISTURE THRESHOLD LINES
    if (
      currentTrendMetric ===
      'moisture'
    ) {
      [10, 11.5].forEach(
        threshold => {
          const y =
            getY(
              threshold
            );


          trendSvg.appendChild(
            createSvgLine(
              padLeft,
              y,
              padLeft + chartW,
              y,
              'var(--text-muted)',
              1,
              '5,4'
            )
          );
        }
      );
    }


    // PRODUCTION TARGET
    if (
      currentTrendMetric ===
      'production'
    ) {
      const yTarget =
        getY(
          productionTarget
        );


      trendSvg.appendChild(
        createSvgLine(
          padLeft,
          yTarget,
          padLeft + chartW,
          yTarget,
          'var(--accent-blue)',
          1.5,
          '5,4'
        )
      );


      const targetLabel =
        createSvgText(
          padLeft +
          chartW -
          4,
          Math.max(
            10,
            yTarget - 5
          ),
          `TARGET ${Math.round(productionTarget).toLocaleString('en-IN')} MT`,
          'end'
        );


      targetLabel.setAttribute(
        'fill',
        'var(--accent-blue)'
      );

      targetLabel.setAttribute(
        'font-size',
        '8'
      );


      trendSvg.appendChild(
        targetLabel
      );
    }


    // X AXIS
    let tickCount = 5;


    if (width < 600) {
      tickCount = 4;
    }


    if (width < 420) {
      tickCount = 3;
    }


    for (
      let i = 0;
      i < tickCount;
      i++
    ) {
      const ratio =
        i /
        (
          tickCount -
          1
        );


      const time =
        chartViewStart +
        ratio *
        timeSpan;


      const x =
        padLeft +
        ratio *
        chartW;


      const labelText =
        formatChartAxisTime(
          time,
          timeSpan
        );


      const anchor =
        i === 0
          ? 'start'
          : (
              i ===
              tickCount - 1
                ? 'end'
                : 'middle'
            );


      const label =
        createSvgText(
          x,
          height - 6,
          labelText,
          anchor
        );


      label.setAttribute(
        'fill',
        'var(--text-muted)'
      );

      label.setAttribute(
        'font-size',
        '9'
      );


      trendSvg.appendChild(
        label
      );
    }


    // NO DATA
    if (
      visibleData.length === 0
    ) {
      const noData =
        createSvgText(
          padLeft +
          chartW / 2,
          padTop +
          chartH / 2,
          'No Data Available',
          'middle'
        );


      noData.setAttribute(
        'fill',
        'var(--text-muted)'
      );


      trendSvg.appendChild(
        noData
      );


      attachInteractiveChartEvents({
        padLeft,
        padTop,
        chartW,
        chartH,
        width,
        height,
        getX,
        getY,
        visibleData
      });


      return;
    }


    const lineColor =
      currentTrendMetric ===
      'moisture'
        ? 'var(--accent-cyan)'
        : 'var(--accent-blue)';


    // GAP-AWARE LINE
    let segment = [];


    function flushSegment() {
      if (
        segment.length === 0
      ) {
        return;
      }


      if (
        segment.length === 1
      ) {
        const point =
          segment[0];


        trendSvg.appendChild(
          createSvgCircle(
            getX(point.ts),
            getY(point.value),
            2.5,
            lineColor
          )
        );


        segment = [];
        return;
      }


      const polyline =
        document.createElementNS(
          'http://www.w3.org/2000/svg',
          'polyline'
        );


      polyline.setAttribute(
        'points',
        segment
          .map(
            point =>
              `${getX(point.ts).toFixed(1)},${getY(point.value).toFixed(1)}`
          )
          .join(' ')
      );


      polyline.setAttribute(
        'fill',
        'none'
      );

      polyline.setAttribute(
        'stroke',
        lineColor
      );

      polyline.setAttribute(
        'stroke-width',
        '2'
      );

      polyline.setAttribute(
        'stroke-linejoin',
        'round'
      );

      polyline.setAttribute(
        'stroke-linecap',
        'round'
      );


      trendSvg.appendChild(
        polyline
      );


      segment = [];
    }


    for (
      let i = 0;
      i < visibleData.length;
      i++
    ) {
      const current =
        visibleData[i];


      if (
        segment.length > 0
      ) {
        const previous =
          segment[
            segment.length - 1
          ];


        const gap =
          parseTrendTime(
            current.ts
          ) -
          parseTrendTime(
            previous.ts
          );


        if (
          gap >
          TREND_GAP_MS
        ) {
          flushSegment();
        }
      }


      segment.push(
        current
      );
    }


    flushSegment();


    // MIN / MAX / LATEST
    let minPoint =
      visibleData[0];


    let maxPoint =
      visibleData[0];


    visibleData.forEach(
      point => {
        if (
          point.value <
          minPoint.value
        ) {
          minPoint =
            point;
        }


        if (
          point.value >
          maxPoint.value
        ) {
          maxPoint =
            point;
        }
      }
    );


    const latestPoint =
      visibleData[
        visibleData.length - 1
      ];


    drawSpecialPoint(
      minPoint,
      'MIN',
      getX,
      getY
    );


    if (
      maxPoint !==
      minPoint
    ) {
      drawSpecialPoint(
        maxPoint,
        'MAX',
        getX,
        getY
      );
    }


    if (
      latestPoint &&
      latestPoint !== minPoint &&
      latestPoint !== maxPoint
    ) {
      trendSvg.appendChild(
        createSvgCircle(
          getX(
            latestPoint.ts
          ),
          getY(
            latestPoint.value
          ),
          4,
          lineColor,
          'var(--surface)',
          2
        )
      );
    }


    // RANGE STATISTICS
    drawChartStatistics(
      visibleData,
      width
    );


    // PINNED POINT
    if (
      chartPinnedPoint
    ) {
      drawPinnedPoint(
        chartPinnedPoint,
        getX,
        getY
      );
    }


    // INTERACTION
    attachInteractiveChartEvents({
      padLeft,
      padTop,
      chartW,
      chartH,
      width,
      height,
      getX,
      getY,
      visibleData
    });
  }


  function drawSpecialPoint(
    point,
    labelText,
    getX,
    getY
  ) {
    if (!point) return;


    const x =
      getX(
        point.ts
      );


    const y =
      getY(
        point.value
      );


    trendSvg.appendChild(
      createSvgCircle(
        x,
        y,
        3.5,
        'var(--surface)',
        'var(--text-primary)',
        1.5
      )
    );


    const label =
      createSvgText(
        x,
        Math.max(
          12,
          y - 8
        ),
        labelText,
        'middle'
      );


    label.setAttribute(
      'fill',
      'var(--text-muted)'
    );

    label.setAttribute(
      'font-size',
      '8'
    );

    label.setAttribute(
      'font-weight',
      '600'
    );


    trendSvg.appendChild(
      label
    );
  }


  function drawChartStatistics(
    data,
    width
  ) {
    if (
      !data ||
      data.length === 0
    ) {
      return;
    }


    const values =
      data
        .map(
          point =>
            Number(
              point.value
            )
        )
        .filter(
          value =>
            Number.isFinite(value)
        );


    if (
      values.length === 0
    ) {
      return;
    }


    const min =
      Math.min(
        ...values
      );


    const max =
      Math.max(
        ...values
      );


    const avg =
      values.reduce(
        (total, value) =>
          total + value,
        0
      ) /
      values.length;


    const format =
      value => {
        if (
          currentTrendMetric ===
          'moisture'
        ) {
          return (
            value.toFixed(2) +
            '%'
          );
        }


        return (
          Math.round(value)
            .toLocaleString('en-IN') +
          ' MT'
        );
      };


    const summary =
      `MIN ${format(min)}   ` +
      `AVG ${format(avg)}   ` +
      `MAX ${format(max)}   ` +
      `${data.length} READINGS`;


    const text =
      createSvgText(
        width - 18,
        12,
        summary,
        'end'
      );


    text.setAttribute(
      'fill',
      'var(--text-muted)'
    );

    text.setAttribute(
      'font-size',
      '8'
    );


    trendSvg.appendChild(
      text
    );
  }


  function drawPinnedPoint(
    point,
    getX,
    getY
  ) {
    if (!point) return;


    const time =
      parseTrendTime(
        point.ts
      );


    if (
      !Number.isFinite(time) ||
      time < chartViewStart ||
      time > chartViewEnd
    ) {
      return;
    }


    trendSvg.appendChild(
      createSvgCircle(
        getX(
          point.ts
        ),
        getY(
          point.value
        ),
        6,
        'transparent',
        'var(--accent-blue)',
        2
      )
    );
  }


  function findNearestTrendPoint(
    mouseX,
    padLeft,
    chartW,
    data
  ) {
    if (
      !data ||
      data.length === 0
    ) {
      return null;
    }


    const mouseTime =
      chartViewStart +
      (
        (
          mouseX -
          padLeft
        ) /
        chartW
      ) *
      (
        chartViewEnd -
        chartViewStart
      );


    let nearest =
      data[0];


    let nearestDifference =
      Math.abs(
        parseTrendTime(
          nearest.ts
        ) -
        mouseTime
      );


    for (
      let i = 1;
      i < data.length;
      i++
    ) {
      const difference =
        Math.abs(
          parseTrendTime(
            data[i].ts
          ) -
          mouseTime
        );


      if (
        difference <
        nearestDifference
      ) {
        nearest =
          data[i];

        nearestDifference =
          difference;
      }
    }


    return nearest;
  }


  function showInteractiveTooltip(
    point,
    x,
    y,
    width
  ) {
    if (
      !chartTooltip ||
      !point
    ) {
      return;
    }


    const pointTime =
      parseTrendTime(
        point.ts
      );


    const date =
      new Date(
        pointTime
      );


    const dateStr =
      date.toLocaleDateString(
        'en-IN',
        {
          timeZone:
            'Asia/Kolkata',

          day:
            '2-digit',

          month:
            'short',

          year:
            'numeric'
        }
      );


    const timeStr =
      date.toLocaleTimeString(
        'en-IN',
        {
          timeZone:
            'Asia/Kolkata',

          hour:
            '2-digit',

          minute:
            '2-digit',

          second:
            '2-digit',

          hour12:
            false
        }
      );


    const shift =
      getShiftForTime(
        pointTime
      );


    const value =
      Number(
        point.value
      );


    let detail = '';


    if (
      currentTrendMetric ===
      'moisture'
    ) {
      let status =
        'NORMAL';


      if (
        value >
        11.5
      ) {
        status =
          'CRITICAL';

      } else if (
        value >= 10
      ) {
        status =
          'WARNING';
      }


      detail =
        `${status} · SHIFT ${shift}`;

    } else {
      const target =
        (
          lastTagState &&
          lastTagState.thresholds
        )
          ? Number(
              lastTagState
                .thresholds
                .day_production_target_mt
            ) || 16000
          : 16000;


      const pct =
        target
          ? (
              value /
              target *
              100
            ).toFixed(1)
          : '0.0';


      detail =
        `${pct}% TARGET · SHIFT ${shift}`;
    }


    const display =
      currentTrendMetric ===
      'moisture'
        ? `${value.toFixed(2)} %`
        : `${Math.round(value).toLocaleString('en-IN')} MT`;


    chartTooltip.innerHTML =
      `<strong>${display}</strong>` +
      `<br>` +
      `<span style="color:var(--text-muted);font-size:9px;">` +
      `${dateStr} ${timeStr} IST` +
      `<br>${detail}` +
      `</span>`;


    const tooltipX =
      x + 15 >
      width - 165
        ? x - 170
        : x + 12;


    chartTooltip.style.left =
      `${Math.max(4, tooltipX)}px`;


    chartTooltip.style.top =
      `${Math.max(10, y - 50)}px`;


    chartTooltip.classList.remove(
      'hidden'
    );
  }


  function attachInteractiveChartEvents(ctx) {
    const {
      padLeft,
      padTop,
      chartW,
      chartH,
      width,
      getX,
      getY,
      visibleData
    } = ctx;


    // Hover guideline
    const hoverLine =
      createSvgLine(
        0,
        padTop,
        0,
        padTop + chartH,
        'rgba(148,163,184,0.55)',
        1,
        '3,3'
      );


    hoverLine.style.display =
      'none';


    trendSvg.appendChild(
      hoverLine
    );


    // Hover point
    const hoverPoint =
      createSvgCircle(
        0,
        0,
        4,
        'var(--surface)',
        'var(--accent-blue)',
        2
      );


    hoverPoint.style.display =
      'none';


    trendSvg.appendChild(
      hoverPoint
    );


    // Drag selection
    const selectionRect =
      createSvgRect(
        0,
        padTop,
        0,
        chartH,
        'rgba(59,130,246,0.12)'
      );


    selectionRect.setAttribute(
      'stroke',
      'var(--accent-blue)'
    );

    selectionRect.setAttribute(
      'stroke-width',
      '1'
    );

    selectionRect.style.display =
      'none';


    trendSvg.appendChild(
      selectionRect
    );


    trendSvg.style.cursor =
      'crosshair';


    // ---------------------------------------------------------
    // MOVE
    // ---------------------------------------------------------
    trendSvg.onmousemove =
      function(event) {
        const rect =
          trendSvg.getBoundingClientRect();


        const mouseX =
          event.clientX -
          rect.left;


        const mouseY =
          event.clientY -
          rect.top;


        // PAN
        if (
          chartDragging &&
          chartPanning
        ) {
          chartDragCurrentX =
            Math.min(
              padLeft + chartW,
              Math.max(
                padLeft,
                mouseX
              )
            );


          const dx =
            chartDragCurrentX -
            chartDragStartX;


          const originalSpan =
            chartPanOriginalEnd -
            chartPanOriginalStart;


          const timeShift =
            (
              dx /
              chartW
            ) *
            originalSpan;


          let newStart =
            chartPanOriginalStart -
            timeShift;


          let newEnd =
            chartPanOriginalEnd -
            timeShift;


          if (
            newStart <
            chartBaseStart
          ) {
            const difference =
              chartBaseStart -
              newStart;


            newStart +=
              difference;

            newEnd +=
              difference;
          }


          if (
            newEnd >
            chartBaseEnd
          ) {
            const difference =
              newEnd -
              chartBaseEnd;


            newStart -=
              difference;

            newEnd -=
              difference;
          }


          chartViewStart =
            newStart;

          chartViewEnd =
            newEnd;


          renderTrendChart();
          return;
        }


        // ZOOM SELECTION
        if (
          chartDragging &&
          !chartPanning
        ) {
          chartDragCurrentX =
            Math.min(
              padLeft + chartW,
              Math.max(
                padLeft,
                mouseX
              )
            );


          const left =
            Math.min(
              chartDragStartX,
              chartDragCurrentX
            );


          const selectionWidth =
            Math.abs(
              chartDragCurrentX -
              chartDragStartX
            );


          selectionRect.setAttribute(
            'x',
            left
          );

          selectionRect.setAttribute(
            'width',
            selectionWidth
          );

          selectionRect.style.display =
            'block';


          return;
        }


        // NORMAL HOVER
        if (
          mouseX < padLeft ||
          mouseX > padLeft + chartW ||
          mouseY < padTop ||
          mouseY > padTop + chartH
        ) {
          hoverLine.style.display =
            'none';

          hoverPoint.style.display =
            'none';

          if (chartTooltip) {
            chartTooltip.classList.add(
              'hidden'
            );
          }

          return;
        }


        const point =
          findNearestTrendPoint(
            mouseX,
            padLeft,
            chartW,
            visibleData
          );


        if (!point) {
          return;
        }


        const x =
          getX(
            point.ts
          );


        const y =
          getY(
            point.value
          );


        hoverLine.setAttribute(
          'x1',
          x
        );

        hoverLine.setAttribute(
          'x2',
          x
        );

        hoverLine.style.display =
          'block';


        hoverPoint.setAttribute(
          'cx',
          x
        );

        hoverPoint.setAttribute(
          'cy',
          y
        );

        hoverPoint.style.display =
          'block';


        showInteractiveTooltip(
          point,
          x,
          y,
          width
        );
      };


    // ---------------------------------------------------------
    // DOWN
    // ---------------------------------------------------------
    trendSvg.onmousedown =
      function(event) {
        if (
          event.button !== 0
        ) {
          return;
        }


        const rect =
          trendSvg.getBoundingClientRect();


        const mouseX =
          event.clientX -
          rect.left;


        const mouseY =
          event.clientY -
          rect.top;


        if (
          mouseX < padLeft ||
          mouseX > padLeft + chartW ||
          mouseY < padTop ||
          mouseY > padTop + chartH
        ) {
          return;
        }


        chartDragging =
          true;


        chartPanning =
          event.shiftKey;


        chartDragStartX =
          mouseX;


        chartDragCurrentX =
          mouseX;


        chartPanOriginalStart =
          chartViewStart;


        chartPanOriginalEnd =
          chartViewEnd;


        trendSvg.style.cursor =
          chartPanning
            ? 'grabbing'
            : 'ew-resize';


        event.preventDefault();
      };


    // ---------------------------------------------------------
    // UP
    // ---------------------------------------------------------
    trendSvg.onmouseup =
      function() {
        if (!chartDragging) {
          return;
        }


        chartDragging =
          false;


        trendSvg.style.cursor =
          'crosshair';


        // PAN COMPLETE
        if (chartPanning) {
          chartPanning =
            false;

          renderTrendChart();
          return;
        }


        const distance =
          Math.abs(
            chartDragCurrentX -
            chartDragStartX
          );


        // CLICK = PIN
        if (
          distance < 6
        ) {
          const point =
            findNearestTrendPoint(
              chartDragCurrentX,
              padLeft,
              chartW,
              visibleData
            );


          if (point) {
            if (
              chartPinnedPoint &&
              chartPinnedPoint.ts ===
              point.ts
            ) {
              chartPinnedPoint =
                null;

            } else {
              chartPinnedPoint =
                point;
            }


            renderTrendChart();
          }


          return;
        }


        // DRAG = ZOOM
        const left =
          Math.min(
            chartDragStartX,
            chartDragCurrentX
          );


        const right =
          Math.max(
            chartDragStartX,
            chartDragCurrentX
          );


        const currentSpan =
          chartViewEnd -
          chartViewStart;


        const startRatio =
          (
            left -
            padLeft
          ) /
          chartW;


        const endRatio =
          (
            right -
            padLeft
          ) /
          chartW;


        const newStart =
          chartViewStart +
          startRatio *
          currentSpan;


        const newEnd =
          chartViewStart +
          endRatio *
          currentSpan;


        // minimum zoom = 5 seconds
        if (
          newEnd -
          newStart >=
          5000
        ) {
          chartViewStart =
            newStart;

          chartViewEnd =
            newEnd;
        }


        renderTrendChart();
      };


    // ---------------------------------------------------------
    // LEAVE
    // ---------------------------------------------------------
    trendSvg.onmouseleave =
      function() {
        if (
          chartDragging
        ) {
          chartDragging =
            false;

          chartPanning =
            false;

          trendSvg.style.cursor =
            'crosshair';
        }


        hoverLine.style.display =
          'none';


        hoverPoint.style.display =
          'none';


        if (chartTooltip) {
          chartTooltip.classList.add(
            'hidden'
          );
        }
      };


    // ---------------------------------------------------------
    // WHEEL ZOOM
    // ---------------------------------------------------------
    trendSvg.onwheel =
      function(event) {
        const rect =
          trendSvg.getBoundingClientRect();


        const mouseX =
          event.clientX -
          rect.left;


        const mouseY =
          event.clientY -
          rect.top;


        if (
          mouseX < padLeft ||
          mouseX > padLeft + chartW ||
          mouseY < padTop ||
          mouseY > padTop + chartH
        ) {
          return;
        }


        event.preventDefault();


        const ratio =
          (
            mouseX -
            padLeft
          ) /
          chartW;


        const currentSpan =
          chartViewEnd -
          chartViewStart;


        // Up = zoom in
        // Down = zoom out
        const factor =
          event.deltaY < 0
            ? 0.8
            : 1.25;


        let newSpan =
          currentSpan *
          factor;


        const minimumSpan =
          30 *
          1000;


        const maximumSpan =
          Math.max(
            minimumSpan,
            chartBaseEnd -
            chartBaseStart
          );


        newSpan =
          Math.max(
            minimumSpan,
            Math.min(
              maximumSpan,
              newSpan
            )
          );


        const cursorTime =
          chartViewStart +
          ratio *
          currentSpan;


        let newStart =
          cursorTime -
          ratio *
          newSpan;


        let newEnd =
          newStart +
          newSpan;


        if (
          newStart <
          chartBaseStart
        ) {
          newStart =
            chartBaseStart;

          newEnd =
            newStart +
            newSpan;
        }


        if (
          newEnd >
          chartBaseEnd
        ) {
          newEnd =
            chartBaseEnd;

          newStart =
            newEnd -
            newSpan;
        }


        newStart =
          Math.max(
            chartBaseStart,
            newStart
          );


        newEnd =
          Math.min(
            chartBaseEnd,
            newEnd
          );


        chartViewStart =
          newStart;


        chartViewEnd =
          newEnd;


        renderTrendChart();
      };


    // ---------------------------------------------------------
    // DOUBLE CLICK = RESET
    // ---------------------------------------------------------
    trendSvg.ondblclick =
      function(event) {
        event.preventDefault();

        resetChartView(
          true
        );
      };
  }


  // =========================================================================
  // ADMIN CONFIG MODULE
  // =========================================================================

  function openAdminModal() {
    adminModal.classList.remove('hidden');
    stepLogin.classList.remove('hidden');
    stepConfig.classList.add('hidden');
    loginFeedback.classList.add('hidden');
    adminPwd.value = '';
    adminPwd.focus();
  }


  function closeAdminModal() {
    adminModal.classList.add('hidden');
  }


  async function handleAdminLogin() {
    loginFeedback.classList.add('hidden');

    const pwd =
      adminPwd.value;


    try {
      const res =
        await fetch(
          '/api/admin/login',
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify({
                password: pwd
              })
          }
        );


      if (res.ok) {
        stepLogin.classList.add(
          'hidden'
        );

        stepConfig.classList.remove(
          'hidden'
        );

        loadConfigForm();

      } else {
        loginFeedback.textContent =
          'Incorrect password. Access denied.';

        loginFeedback.className =
          'form-feedback error';

        loginFeedback.classList.remove(
          'hidden'
        );
      }

    } catch (e) {
      loginFeedback.textContent =
        'Server communication error.';

      loginFeedback.className =
        'form-feedback error';

      loginFeedback.classList.remove(
        'hidden'
      );
    }
  }


  async function loadConfigForm() {
    try {
      const res =
        await fetch(
          '/api/config'
        );


      if (!res.ok) {
        return;
      }


      const cfg =
        await res.json();


      document.getElementById(
        'cfg-prod-target'
      ).value =
        cfg.day_production_target_mt ||
        16000;


      document.getElementById(
        'cfg-gp3-sp'
      ).value =
        cfg.gp3_setpoint_tph ||
        440;


      document.getElementById(
        'cfg-stale-sec'
      ).value =
        cfg.stale_after_seconds ||
        60;


      document.getElementById(
        'cfg-moist-green'
      ).value =
        cfg.moisture_green_max ||
        10.0;


      document.getElementById(
        'cfg-moist-yellow'
      ).value =
        cfg.moisture_yellow_max ||
        11.5;


      document.getElementById(
        'cfg-bin-starv'
      ).value =
        cfg.bin_starvation_pct ||
        15.0;


      document.getElementById(
        'cfg-bin-low'
      ).value =
        cfg.bin_low_pct ||
        25.0;


      document.getElementById(
        'cfg-bin-over'
      ).value =
        cfg.bin_overfeed_pct ||
        80.0;


      document.getElementById(
        'cfg-var-green'
      ).value =
        cfg.variance_green_tph ||
        5.0;


      document.getElementById(
        'cfg-db-host'
      ).value =
        cfg.db_host || '';


      document.getElementById(
        'cfg-db-port'
      ).value =
        cfg.db_port || 1433;


      document.getElementById(
        'cfg-db-name'
      ).value =
        cfg.db_name || '';


      document.getElementById(
        'cfg-db-user'
      ).value =
        cfg.db_user || '';


      document.getElementById(
        'cfg-db-pwd'
      ).value = '';


    } catch (e) {
      console.error(
        'Config fetch error:',
        e
      );
    }
  }


  async function saveConfigForm() {
    configFeedback.classList.add(
      'hidden'
    );


    const payload = {
      day_production_target_mt:
        Number(
          document.getElementById(
            'cfg-prod-target'
          ).value
        ),

      gp3_setpoint_tph:
        Number(
          document.getElementById(
            'cfg-gp3-sp'
          ).value
        ),

      stale_after_seconds:
        Number(
          document.getElementById(
            'cfg-stale-sec'
          ).value
        ),

      moisture_green_max:
        Number(
          document.getElementById(
            'cfg-moist-green'
          ).value
        ),

      moisture_yellow_max:
        Number(
          document.getElementById(
            'cfg-moist-yellow'
          ).value
        ),

      bin_starvation_pct:
        Number(
          document.getElementById(
            'cfg-bin-starv'
          ).value
        ),

      bin_low_pct:
        Number(
          document.getElementById(
            'cfg-bin-low'
          ).value
        ),

      bin_overfeed_pct:
        Number(
          document.getElementById(
            'cfg-bin-over'
          ).value
        ),

      variance_green_tph:
        Number(
          document.getElementById(
            'cfg-var-green'
          ).value
        ),

      db_host:
        document.getElementById(
          'cfg-db-host'
        ).value,

      db_port:
        document.getElementById(
          'cfg-db-port'
        ).value,

      db_name:
        document.getElementById(
          'cfg-db-name'
        ).value,

      db_user:
        document.getElementById(
          'cfg-db-user'
        ).value,

      db_pwd:
        document.getElementById(
          'cfg-db-pwd'
        ).value
    };


    try {
      const res =
        await fetch(
          '/api/config',
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify(
                payload
              )
          }
        );


      if (res.ok) {
        configFeedback.textContent =
          'Configuration saved and applied live.';

        configFeedback.className =
          'form-feedback success';

        configFeedback.classList.remove(
          'hidden'
        );


        setTimeout(
          () => {
            closeAdminModal();
          },
          1200
        );

      } else {
        configFeedback.textContent =
          'Failed to save configuration.';

        configFeedback.className =
          'form-feedback error';

        configFeedback.classList.remove(
          'hidden'
        );
      }

    } catch (e) {
      configFeedback.textContent =
        'Server communication error.';

      configFeedback.className =
        'form-feedback error';

      configFeedback.classList.remove(
        'hidden'
      );
    }
  }


  async function testDbConnection() {
    dbTestResult.textContent =
      'Testing connection...';

    dbTestResult.style.color =
      'var(--text-muted)';


    try {
      const res =
        await fetch(
          '/api/config/test',
          {
            method: 'POST'
          }
        );


      const data =
        await res.json();


      if (
        data.status ===
        'ok'
      ) {
        dbTestResult.textContent =
          'Connection Successful';

        dbTestResult.style.color =
          'var(--state-ok)';

      } else {
        dbTestResult.textContent =
          `Failed: ${data.error}`;

        dbTestResult.style.color =
          'var(--state-crit)';
      }

    } catch (e) {
      dbTestResult.textContent =
        'Test failed to run';

      dbTestResult.style.color =
        'var(--state-crit)';
    }
  }


  // =========================================================================
  // EVENT LISTENERS
  // =========================================================================

  btnTheme.addEventListener(
    'click',
    toggleTheme
  );


  btnFullscreen.addEventListener(
    'click',
    toggleFullscreen
  );


  btnPrint.addEventListener(
    'click',
    () => window.print()
  );


  btnPause.addEventListener(
    'click',
    () => {
      isPaused =
        !isPaused;


      if (isPaused) {
        iconPause.classList.add(
          'hidden'
        );

        iconPlay.classList.remove(
          'hidden'
        );

        labelPause.textContent =
          'Paused';

        pauseTime.textContent =
          lastDataTime;

        pauseBanner.classList.remove(
          'hidden'
        );

      } else {
        iconPause.classList.remove(
          'hidden'
        );

        iconPlay.classList.add(
          'hidden'
        );

        labelPause.textContent =
          'Live';

        pauseBanner.classList.add(
          'hidden'
        );

        fetchTags();
      }
    }
  );


  btnAudio.addEventListener(
    'click',
    () => {
      audioEnabled =
        !audioEnabled;


      if (audioEnabled) {
        iconAudioOff.classList.add(
          'hidden'
        );

        iconAudioOn.classList.remove(
          'hidden'
        );

        playAlarmBeep();

      } else {
        iconAudioOff.classList.remove(
          'hidden'
        );

        iconAudioOn.classList.add(
          'hidden'
        );
      }
    }
  );


  btnFilterAll.addEventListener(
    'click',
    () => {
      currentBinFilter =
        'all';

      btnFilterAll.classList.add(
        'active'
      );

      btnFilterAlert.classList.remove(
        'active'
      );

      if (lastTagState) {
        renderDashboard(
          lastTagState
        );
      }
    }
  );


  btnFilterAlert.addEventListener(
    'click',
    () => {
      currentBinFilter =
        'alert';

      btnFilterAlert.classList.add(
        'active'
      );

      btnFilterAll.classList.remove(
        'active'
      );

      if (lastTagState) {
        renderDashboard(
          lastTagState
        );
      }
    }
  );


  tabMoisture.addEventListener(
    'click',
    () => {
      currentTrendMetric =
        'moisture';

      tabMoisture.classList.add(
        'active'
      );

      tabProduction.classList.remove(
        'active'
      );

      chartPinnedPoint =
        null;

      fetchTrendData();
    }
  );


  tabProduction.addEventListener(
    'click',
    () => {
      currentTrendMetric =
        'production';

      tabProduction.classList.add(
        'active'
      );

      tabMoisture.classList.remove(
        'active'
      );

      chartPinnedPoint =
        null;

      fetchTrendData();
    }
  );


  rangeBtns.forEach(
    btn => {
      btn.addEventListener(
        'click',
        () => {
          rangeBtns.forEach(
            b => {
              b.classList.remove(
                'active'
              );
            }
          );


          btn.classList.add(
            'active'
          );


          currentTrendRange =
            btn.getAttribute(
              'data-range'
            );


          chartPinnedPoint =
            null;


          chartViewStart =
            null;


          chartViewEnd =
            null;


          if (
            currentTrendRange ===
            'custom'
          ) {
            customRangeBar.classList.remove(
              'hidden'
            );

          } else {
            customRangeBar.classList.add(
              'hidden'
            );

            fetchTrendData();
          }
        }
      );
    }
  );


  btnApplyRange.addEventListener(
    'click',
    () => {
      chartViewStart =
        null;

      chartViewEnd =
        null;

      chartPinnedPoint =
        null;

      fetchTrendData();
    }
  );


  btnAdmin.addEventListener(
    'click',
    openAdminModal
  );


  btnModalClose.addEventListener(
    'click',
    closeAdminModal
  );


  btnAdminLogin.addEventListener(
    'click',
    handleAdminLogin
  );


  adminPwd.addEventListener(
    'keydown',
    e => {
      if (
        e.key ===
        'Enter'
      ) {
        handleAdminLogin();
      }
    }
  );


  btnAdminLogout.addEventListener(
    'click',
    async () => {
      await fetch(
        '/api/admin/logout',
        {
          method: 'POST'
        }
      );

      closeAdminModal();
    }
  );


  btnSaveConfig.addEventListener(
    'click',
    saveConfigForm
  );


  btnTestDb.addEventListener(
    'click',
    testDbConnection
  );


  btnResetDefaults.addEventListener(
    'click',
    () => {
      document.getElementById(
        'cfg-prod-target'
      ).value = 16000;


      document.getElementById(
        'cfg-gp3-sp'
      ).value = 440;


      document.getElementById(
        'cfg-stale-sec'
      ).value = 60;


      document.getElementById(
        'cfg-moist-green'
      ).value = 10.0;


      document.getElementById(
        'cfg-moist-yellow'
      ).value = 11.5;


      document.getElementById(
        'cfg-bin-starv'
      ).value = 15.0;


      document.getElementById(
        'cfg-bin-low'
      ).value = 25.0;


      document.getElementById(
        'cfg-bin-over'
      ).value = 80.0;


      document.getElementById(
        'cfg-var-green'
      ).value = 5.0;
    }
  );


  document
    .querySelectorAll(
      '.modal-tab-btn'
    )
    .forEach(
      btn => {
        btn.addEventListener(
          'click',
          () => {
            document
              .querySelectorAll(
                '.modal-tab-btn'
              )
              .forEach(
                b => {
                  b.classList.remove(
                    'active'
                  );
                }
              );


            document
              .querySelectorAll(
                '.tab-pane'
              )
              .forEach(
                p => {
                  p.classList.add(
                    'hidden'
                  );
                }
              );


            btn.classList.add(
              'active'
            );


            const pane =
              document.getElementById(
                `pane-${btn.getAttribute('data-tab')}`
              );


            if (pane) {
              pane.classList.remove(
                'hidden'
              );
            }
          }
        );
      }
    );


  // Redraw chart when browser size changes
  window.addEventListener(
    'resize',
    () => {
      renderTrendChart();
    }
  );


  // =========================================================================
  // INITIALIZATION
  // =========================================================================

  initTheme();

  fetchTags();

  fetchTrendData();


  // Main dashboard polling
  pollInterval =
    setInterval(
      fetchTags,
      3000
    );


  // Trend polling
  setInterval(
    () => {
      if (
        currentTrendRange ===
        'live'
      ) {
        fetchTrendData();
      }
    },
    10000
  );

})();