/* 主控：诊断循环、会话生命周期、视图切换、设置 */

import * as camera from './camera.js';
import * as vlm from './vlm.js';
import * as overlay from './overlay.js';
import * as store from './store.js';
import * as filters from './filters.js';
import * as localcoach from './localcoach.js';
import { buildShareCard } from './sharecard.js';
import { getTemplate } from './templates.js';

const $ = (id) => document.getElementById(id);
const LS_KEY = 'cc-settings';

const DEFAULT_SETTINGS = {
  preset: 'deepseek',
  baseUrl: vlm.PRESETS.deepseek.baseUrl,
  model: vlm.PRESETS.deepseek.model,
  apiKey: '',
  intervalMs: 1600,
  auto: false,
  inspiration: true,  // 灵感构图模板（AI 按场景自动推荐）
  ratio: '',          // 成片画幅标签，'' = 原始
  mode: 'auto',       // 场景模式：auto / person / food / scene
  autoCapture: false, // 构图达标自动抓拍（本地运行，不耗 token）
};

const MAX_FRAMES = 60;
const CLOUD_HOLD_MS = 4000;  // 云端诊断结果保持期，期内不让本地教练覆盖

/* 画幅比例：value 为宽/高；竖屏视频自动取倒（选 4:3 实际裁 3:4 竖幅） */
const RATIOS = [
  { label: '原始', value: 0 },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '2.35:1', value: 2.35 },
];

/* 场景模式：id 与 localcoach MODES / vlm MODE_HINTS 约定一致 */
const SCENES = [
  { id: 'auto', label: '自动' },
  { id: 'person', label: '拍人' },
  { id: 'food', label: '美食·静物' },
  { id: 'scene', label: '风光' },
];

let settings = loadSettings();
let session = null;
let analyzing = false;
let analyzingUI = false;
let timer = null;
let abortCtrl = null;
let currentSessionId = null;

let currentRatio = settings.ratio || '';   // 当前成片画幅（RATIOS 里的 label）
let orientationSeen = false;               // 是否收到过姿态传感器数据
let rollFiltered = null;                   // 低通滤波后的设备倾角
let lastAspectSuggest = '';                // 上次 AI 建议的画幅（防 toast 刷屏）
let lastFilterSuggest = '';                // 上次 AI 建议的滤镜（防 toast 刷屏）
let zoomGate = { target: null, count: 0, appliedAt: 0 };  // 自动变焦闸门状态

const stage = $('stage');
const video = camera.getVideo();

/* ---------- 设置 ---------- */

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* 忽略坏数据 */ }
  return { ...DEFAULT_SETTINGS };
}

function persistSettings() {
  localStorage.setItem(LS_KEY, JSON.stringify(settings));
}

/* ---------- Toast ---------- */

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------- 取景器启动 ---------- */

async function startCamera(facing) {
  setStatus('STANDBY');
  try {
    const f = await camera.start(facing);
    overlay.setMirror(f === 'user');
    reLayout();
    setStatus('LIVE');
    if (!settings.apiKey) {
      if (!session) setCoachIdle('相机已就绪。先在「设置」里填入模型 API Key，我才能开始指导。');
    } else if (!session) {
      setCoachIdle('正在观察取景框……');
    }
    ensureLocalCoach();
  } catch (err) {
    const name = err.name || '';
    let hint = '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      hint = '（相机权限被拒绝：请在系统设置里允许本应用使用相机）';
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      hint = '（未检测到可用摄像头）';
    } else if (name === 'NotReadableError') {
      hint = '（摄像头被其他应用占用，请关闭后重试）';
    }
    setCoachIdle('相机未开启：' + err.message + hint);
    toast('相机启动失败：' + err.message, true);
  }
}

function setStatus(label) {
  $('rec-label').textContent = label;
  $('rec-dot').hidden = label !== 'THINKING';
}

/* ---------- 取景器布局 / 画幅比例 ---------- */

/** 当前生效的画幅（宽/高数值）：竖屏视频自动取倒 */
function effectiveAspect() {
  if (!currentRatio) return 0;
  const r = RATIOS.find((x) => x.label === currentRatio);
  if (!r || !r.value) return 0;
  const va = (video.videoWidth || 16) / (video.videoHeight || 9);
  return va >= 1 ? r.value : 1 / r.value;
}

/** 统一的取景器重排：overlay 画布 + 画幅遮罩一起对齐。
    按 effectiveAspect 判断显隐，「原始」与未选择时都不显示遮罩 */
function reLayout() {
  const aspect = effectiveAspect();
  const rect = overlay.layout(stage, video, camera.getDigitalZoom(), aspect);
  const mask = $('ratio-mask');
  if (aspect > 0) {
    mask.style.display = 'block';
    mask.style.left = rect.x + 'px';
    mask.style.top = rect.y + 'px';
    mask.style.width = rect.w + 'px';
    mask.style.height = rect.h + 'px';
  } else {
    mask.style.display = 'none';
  }
}

function buildRatioRow() {
  const row = $('ratio-row');
  row.innerHTML = '';
  for (const r of RATIOS) {
    const b = document.createElement('button');
    b.className = 'filter-chip' + (r.label === currentRatio ? ' active' : '');
    b.dataset.ratio = r.label;
    b.textContent = r.label;
    b.addEventListener('click', () => applyRatio(r.label));
    row.appendChild(b);
  }
}

function applyRatio(label) {
  currentRatio = label;
  settings.ratio = label;
  persistSettings();
  reLayout();
  buildRatioRow();
  toast(label && label !== '原始' ? '成片画幅 ' + label : '已恢复原始画幅');
}

/* ---------- 灵感构图开关 ---------- */

function syncInspirationUI() {
  $('btn-inspiration').classList.toggle('active', settings.inspiration !== false);
}

function toggleInspiration() {
  settings.inspiration = !settings.inspiration;
  persistSettings();
  syncInspirationUI();
  if (!settings.inspiration) overlay.setTemplate(null);
  toast(settings.inspiration ? '灵感构图已开启：AI 按场景推荐模板' : '灵感构图已关闭');
}

/* ---------- 场景模式（切换本地规则与云端 prompt 的侧重） ---------- */

function buildModeRow() {
  const row = $('mode-row');
  row.innerHTML = '';
  for (const s of SCENES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.mode = s.id;
    b.textContent = s.label;
    b.classList.toggle('active', s.id === (settings.mode || 'auto'));
    b.addEventListener('click', () => applyMode(s.id));
    row.appendChild(b);
  }
}

function applyMode(id) {
  if ((settings.mode || 'auto') === id) return;
  settings.mode = id;
  persistSettings();
  buildModeRow();
  localcoach.setMode(id);
  const s = SCENES.find((x) => x.id === id);
  toast('场景模式：' + (s ? s.label : id));
}

/* ---------- 诊断循环 ---------- */

function startLoop() {
  clearInterval(timer);
  timer = null;
  if (settings.auto) {
    timer = setInterval(tick, Math.max(800, settings.intervalMs));
  }
}

function tick() {
  if (document.body.dataset.view !== 'camera') return;
  if (analyzing || document.hidden || !camera.isReady() || !settings.apiKey) return;
  const shot = camera.capture(640, 0.72, 200, filters.getFilterCss(currentFilterId), effectiveAspect());
  if (!shot) return;

  analyzing = true;
  $('btn-diagnose').disabled = true;
  abortCtrl = new AbortController();
  setStatus('THINKING');
  vlm.analyzeFrame({ dataUrl: shot.dataUrl, settings, signal: abortCtrl.signal, mode: settings.mode || 'auto' })
    .then((diag) => handleDiag(diag, shot.thumb, currentRatio))
    .catch((err) => {
      if (err.name !== 'AbortError') {
        setCoachIdle('诊断失败：' + err.message);
      }
    })
    .finally(() => {
      analyzing = false;
      $('btn-diagnose').disabled = false;
      setStatus(camera.isReady() ? 'LIVE' : 'STANDBY');
    });
}

/* 手动单次诊断（按钮 / 快捷键 D） */
function diagnoseNow() {
  if (document.body.dataset.view !== 'camera') return;
  if (analyzing) { toast('上一轮诊断还在进行中…'); return; }
  if (!camera.isReady()) { toast('相机还没就绪', true); return; }
  if (!settings.apiKey) {
    toast('先在「设置」里填 API Key', true);
    openSettings();
    return;
  }
  tick();
}

/* ---------- 端侧实时教练（混合架构：本地每帧评估，云端深度诊断） ---------- */

let localCoachOn = false;
let userDisabledLocal = false;
let cloudHoldUntil = 0;

function onLocalDiag(diag) {
  if (document.hidden || document.body.dataset.view !== 'camera') return;
  if (Date.now() < cloudHoldUntil) return; // 云端深度诊断结果保持期内不让本地覆盖
  applyDiagUI(diag);
  trackAutoCapture(diag);
}

async function toggleLocalCoach() {
  if (localCoachOn) {
    localCoachOn = false;
    userDisabledLocal = true;
    localcoach.stop();
    resetAutoCap();
    // 水平仪已与实时教练解耦：关闭教练后倾斜指示继续由姿态传感器驱动
    $('btn-local').classList.remove('active');
    toast('端侧实时教练已关闭');
    return;
  }
  if (!camera.isReady()) { toast('相机还没就绪', true); return; }
  const btn = $('btn-local');
  btn.disabled = true;
  try {
    toast('端侧教练启动中…');
    await localcoach.init();
    localcoach.start(camera.getVideo(), onLocalDiag);
    localCoachOn = true;
    userDisabledLocal = false;
    btn.classList.add('active');
    toast('实时教练已开启：对准人物或物体（离线运行）');
  } catch (err) {
    toast('端侧教练启动失败：' + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

/** 相机就绪后自动开启端侧实时教练（用户手动关过则尊重选择） */
async function ensureLocalCoach() {
  if (localCoachOn || userDisabledLocal || !camera.isReady()) return;
  try {
    if (window.DeviceOrientationEvent?.requestPermission) {
      try { await window.DeviceOrientationEvent.requestPermission(); } catch { /* 无倾斜数据也可用 */ }
    }
    await localcoach.init();
    localcoach.start(camera.getVideo(), onLocalDiag);
    localCoachOn = true;
    $('btn-local').classList.add('active');
  } catch { /* 静默失败，用户可手动点「实时」开启 */ }
}

/* ---------- 达标自动抓拍（本地运行，零 token） ---------- */

let autoCapTimer = null;
let autoCapArmed = true;   // 一次达标只拍一张，退出达标后才重新武装

function syncAutoCapUI() {
  $('btn-autocap').classList.toggle('active', !!settings.autoCapture);
}

function toggleAutoCap() {
  settings.autoCapture = !settings.autoCapture;
  persistSettings();
  syncAutoCapUI();
  resetAutoCap();
  toast(settings.autoCapture ? '自动拍已开启：构图达标保持约 1 秒自动抓拍' : '自动拍已关闭');
}

function resetAutoCap() {
  clearTimeout(autoCapTimer);
  autoCapTimer = null;
  autoCapArmed = true;
}

/** 本地教练报达标后起 1.2s 定时器：期间未退出达标、无待确认照片才触发快门。
    仍走"确认预览"，用户可重拍；退出达标重新武装，防同一构图连拍刷屏 */
function trackAutoCapture(diag) {
  if (!settings.autoCapture || !localCoachOn || !diag.done) { resetAutoCap(); return; }
  if (autoCapTimer) return;
  autoCapTimer = setTimeout(() => {
    autoCapTimer = null;
    if (!settings.autoCapture || !localCoachOn || pendingShot || !autoCapArmed) return;
    autoCapArmed = false;
    toast('构图达标，已自动抓拍');
    onShutter();
  }, 1200);
}

function handleDiag(diag, thumb, aspect) {
  cloudHoldUntil = Date.now() + CLOUD_HOLD_MS; // 云端结果短保持，本地平滑教练尽快接管
  if (!session) {
    session = { id: store.uid(), startedAt: Date.now(), endedAt: null, frames: [], finalShot: null };
    sessionSavedOnce = false;
  }
  if (session.frames.length < MAX_FRAMES) {
    session.frames.push({ ts: Date.now(), thumb, diag, aspect: aspect || '', filter: currentFilterId });
  }
  updateSessionTag();
  applyDiagUI(diag);
  persistSessionSoon();
}

/** 变焦闸门：同一目标倍率连续建议 2 次、与当前差 >0.2、冷却 8s 才真正动镜头，
    防止 VLM 输出噪声让镜头来回变焦形成振荡 */
function gateZoomSuggestion(diag) {
  if (diag.done || !diag.zoom_target) { zoomGate.count = 0; return null; }
  const t = Math.min(4, Math.max(0.5, Number(diag.zoom_target)));
  const now = Date.now();
  const same = zoomGate.target != null && Math.abs(zoomGate.target - t) < 0.2;
  zoomGate.count = same ? zoomGate.count + 1 : 1;
  zoomGate.target = t;
  const cur = Number(camera.zoomInfo().current) || 1;
  if (zoomGate.count < 2) return null;
  if (Math.abs(t - cur) <= 0.2) { zoomGate.count = 0; return null; }
  if (now - zoomGate.appliedAt < 8000) return null;
  zoomGate.appliedAt = now;
  zoomGate.count = 0;
  return t;
}

function applyDiagUI(diag) {
  overlay.setDiag(diag);

  // 灵感构图：推荐模板叠加（本地诊断带按主体类型的兜底模板）
  if (settings.inspiration !== false) {
    overlay.setTemplate(diag.template || null);
  }

  // 云端专属：变焦联动与画幅/滤镜建议。本地诊断每帧都来且这些字段恒为空，
  // 若参与其中会把闸门计数与建议去重状态不停清零，云端功能等于失效
  if (!diag.local) {
    // LLM 视角联动：经闸门确认后才真正变焦
    const zoomTarget = gateZoomSuggestion(diag);
    if (zoomTarget != null) {
      camera.zoomToTarget(zoomTarget)
        .then((v) => {
          if (v != null) {
            syncZoomUI();
            toast('AI 视角已调至 ' + Number(v).toFixed(1) + '×');
          }
        })
        .catch(() => {});
    }

    // 每轮云端结果先清旧建议高亮再按最新建议点亮，过期建议不会残留
    document.querySelectorAll('#ratio-row .filter-chip.suggest').forEach((c) => c.classList.remove('suggest'));
    // AI 画幅建议：高亮对应比例胶囊，点击即套用（不自动改）
    if (diag.suggested_aspect && diag.suggested_aspect !== currentRatio) {
      const chip = document.querySelector(`#ratio-row .filter-chip[data-ratio="${diag.suggested_aspect}"]`);
      if (chip) chip.classList.add('suggest');
      if (diag.suggested_aspect !== lastAspectSuggest) {
        lastAspectSuggest = diag.suggested_aspect;
        toast('AI 建议改用 ' + diag.suggested_aspect + ' 画幅 · 点比例条套用');
      }
    } else if (!diag.suggested_aspect) {
      lastAspectSuggest = '';
    }

    document.querySelectorAll('#filter-row .filter-chip.suggest').forEach((c) => c.classList.remove('suggest'));
    // AI 滤镜推荐：高亮对应胶囊，点滤镜条套用（不自动改）
    if (diag.suggested_filter && diag.suggested_filter !== currentFilterId) {
      const chip = document.querySelector(`#filter-row .filter-chip[data-filter="${diag.suggested_filter}"]`);
      if (chip) chip.classList.add('suggest');
      if (diag.suggested_filter !== lastFilterSuggest) {
        lastFilterSuggest = diag.suggested_filter;
        const f = filters.FILTERS.find((x) => x.id === diag.suggested_filter);
        const name = f ? f.name : diag.suggested_filter;
        toast(`AI 建议滤镜「${name}」${diag.filter_reason ? ' · ' + diag.filter_reason : ''} · 点滤镜条套用`);
      }
    } else if (!diag.suggested_filter) {
      lastFilterSuggest = '';
    }
  }

  const bar = $('coach-bar');
  bar.classList.remove('idle', 'done', 'alert');
  bar.classList.add(diag.done ? 'done' : 'alert');
  $('score-num').textContent = String(diag.score);
  $('coach-instruction').textContent = diag.done ? '✓ 可以拍了，就是现在' : diag.instruction;
  $('coach-issues').innerHTML = '';
  const subjectLabel = { person: '主体 · 人物', object: '主体 · 物品', scene: '主体 · 场景' }[diag.subject_type];
  const chips = [subjectLabel, ...diag.issues].filter(Boolean);
  if (diag.template && settings.inspiration !== false) {
    const tpl = getTemplate(diag.template);
    if (tpl) chips.push('灵感 · ' + tpl.name);
  }
  for (const issue of chips) {
    const chipEl = document.createElement('span');
    chipEl.className = 'chip';
    chipEl.textContent = issue;
    $('coach-issues').appendChild(chipEl);
  }
}

/* ---------- 自动持久化：每帧即存，关闭兜底，重开恢复 ---------- */

let persistTimer = null;
let sessionSavedOnce = false;

function persistSessionSoon() {
  if (!session) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistSessionNow, 600);
}

async function persistSessionNow() {
  if (!session) return;
  try {
    await store.saveSession(session);
    sessionSavedOnce = true;
    updateSessionTag();
  } catch { /* 存储失败不打断拍摄 */ }
}

async function restoreLastSession() {
  try {
    const sessions = await store.listSessions();
    const open = sessions.find((s) => !s.endedAt);
    if (!open) return;
    session = open;
    sessionSavedOnce = true;
    updateSessionTag();
    const last = open.frames[open.frames.length - 1];
    if (last?.diag) applyDiagUI(last.diag);
    toast(`已恢复上次未存档的会话（${open.frames.length} 帧），继续拍或点「存档」`);
  } catch { /* 忽略恢复失败 */ }
}

function setCoachIdle(text) {
  const bar = $('coach-bar');
  bar.classList.remove('done', 'alert');
  bar.classList.add('idle');
  $('score-num').textContent = '--';
  $('coach-instruction').textContent = text;
  $('coach-issues').innerHTML = '';
}

function updateSessionTag() {
  const tag = $('session-tag');
  if (session) {
    tag.classList.add('live');
    const saved = sessionSavedOnce ? ' · 已保存' : '';
    tag.textContent = `SESSION ${session.id.toUpperCase()} · ${session.frames.length} 帧${saved}`;
  } else {
    tag.classList.remove('live');
    tag.textContent = 'NO SESSION';
  }
}

/* ---------- 拍照与存档 ---------- */

let pendingShot = null;
let pendingShotCtx = null;   // 按下快门那一刻的教练上下文（用户反馈信号）

/** 快门时刻的上下文快照：记录"拍这一张时教练说了什么、用户用了什么"，
    供会话复盘与后续模型数据分析（用户是否采纳建议的原始信号） */
function shotContext() {
  const last = session && session.frames.length ? session.frames[session.frames.length - 1] : null;
  const d = last ? last.diag : null;
  return {
    ts: Date.now(),
    filterId: currentFilterId,
    usedSuggestedFilter: !!lastFilterSuggest && currentFilterId === lastFilterSuggest,
    scoreAtShutter: d ? d.score : null,
    doneAtShutter: !!(d && d.done),
    diagCount: session ? session.frames.length : 0,
  };
}

function onShutter() {
  if (!camera.isReady()) { toast('相机还没就绪', true); return; }
  // 原生分辨率出片（maxEdge=Infinity 不缩放），画幅裁切与取景器遮罩同口径
  const shot = camera.capture(Infinity, 0.9, 480, filters.getFilterCss(currentFilterId), effectiveAspect());
  if (!shot) return;

  $('flash').classList.remove('fired');
  void $('flash').offsetWidth;
  $('flash').classList.add('fired');

  // 进入拍摄确认预览（滤镜已烘焙在图内）
  pendingShot = shot;
  pendingShotCtx = shotContext();
  $('preview-img').src = shot.dataUrl;
  $('preview-modal').hidden = false;
}

function onRetake() {
  // 重拍也是反馈：记录用户放弃了这一张
  if (session && pendingShotCtx) {
    session.shots = [...(session.shots || []), { ...pendingShotCtx, kept: false }];
    persistSessionSoon();
  }
  pendingShot = null;
  pendingShotCtx = null;
  $('preview-modal').hidden = true;
}

async function onKeepShot() {
  if (!pendingShot) return;
  $('preview-modal').hidden = true;

  if (!session) {
    session = { id: store.uid(), startedAt: Date.now(), endedAt: null, frames: [], finalShot: null };
    sessionSavedOnce = false;
    updateSessionTag();
  }
  const ctx = pendingShotCtx || shotContext();
  session.shots = [...(session.shots || []), { ...ctx, kept: true }];
  session.finalShot = {
    ts: ctx.ts,
    dataUrl: pendingShot.dataUrl,
    thumb: pendingShot.thumb,
    aspect: currentRatio,
    filterId: ctx.filterId,
    usedSuggestedFilter: ctx.usedSuggestedFilter,
    scoreAtShutter: ctx.scoreAtShutter,
    doneAtShutter: ctx.doneAtShutter,
  };
  const lt = $('last-thumb');
  lt.src = pendingShot.thumb;
  lt.hidden = false;
  const ph = $('thumb-ph');
  if (ph) ph.style.display = 'none';
  persistSessionSoon();
  toast('成片已保存进本组 · 记得点「存档」结束本组');
  pendingShot = null;
  pendingShotCtx = null;
}

async function onArchive() {
  if (!session || (!session.frames.length && !session.finalShot)) {
    toast('还没有可存档的内容', true);
    return;
  }
  session.endedAt = Date.now();
  clearTimeout(persistTimer);
  try {
    await store.saveSession(session);
    sessionSavedOnce = false;
    toast(`已存档 · ${session.frames.length} 条诊断记录`);
  } catch (err) {
    toast('存档失败：' + err.message, true);
    return;
  }
  session = null;
  overlay.clear();
  setCoachIdle('本组拍摄已存档。继续取景，开始下一组。');
  updateSessionTag();
}

/* ---------- 滤镜与变焦 UI ---------- */

let currentFilterId = filters.getSavedFilterId();

function applyFilterToPreview() {
  camera.getVideo().style.filter = filters.getFilterCss(currentFilterId);
}

function buildFilterRow() {
  const row = $('filter-row');
  row.innerHTML = '';
  for (const f of filters.FILTERS) {
    const b = document.createElement('button');
    b.className = 'filter-chip' + (f.id === currentFilterId ? ' active' : '');
    b.dataset.filter = f.id;
    b.textContent = f.name;
    b.addEventListener('click', () => {
      currentFilterId = f.id;
      filters.saveFilterId(f.id);
      applyFilterToPreview();
      buildFilterRow();
    });
    row.appendChild(b);
  }
}

function syncZoomUI() {
  const info = camera.zoomInfo();
  const range = (info.max - info.min) || 1;
  const frac = Math.min(1, Math.max(0, (Number(info.current) - info.min) / range));
  $('zoom-thumb').style.left = (frac * 100).toFixed(1) + '%';
  $('zoom-thumb-label').textContent = Number(info.current).toFixed(1) + '×';
  buildZoomTicks(info);
  document.querySelectorAll('#zoom-row .zoom-pill[data-x]').forEach((b) => {
    b.classList.toggle('active', Math.abs(Number(b.dataset.x) - Number(info.current)) < 0.3);
  });
}

function buildZoomTicks(info) {
  const wrap = $('zoom-ticks');
  if (!wrap) return;
  wrap.innerHTML = '';
  const range = (info.max - info.min) || 1;
  const detents = [0.5, 1, 2, 3, 4].filter((d) => d >= info.min && d <= info.max);
  for (const d of detents) {
    const pos = ((d - info.min) / range * 100).toFixed(1) + '%';
    const tick = document.createElement('div');
    tick.className = 'zoom-tick';
    tick.style.left = pos;
    const num = document.createElement('span');
    num.className = 'zoom-tick-num';
    num.style.left = pos;
    num.textContent = d < 1 ? d.toFixed(1) : String(d);
    wrap.appendChild(tick);
    wrap.appendChild(num);
  }
}

/* ---------- 视图切换 ---------- */

function showView(name) {
  document.body.dataset.view = name;
  $('view-camera').hidden = name !== 'camera';
  $('view-review').hidden = name !== 'review';
  $('view-session').hidden = name !== 'session';
  if (name === 'review') renderReview();
}

/* ---------- 档案列表 ---------- */

function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function renderReview() {
  let sessions = [];
  try {
    sessions = await store.listSessions();
  } catch (err) {
    toast('读取档案失败：' + err.message, true);
  }
  $('review-count').textContent = sessions.length ? `${sessions.length} 组` : '';
  const list = $('review-list');
  list.innerHTML = '';

  if (!sessions.length) {
    list.innerHTML = `<div class="empty-state"><div class="big">⛶</div>
      <p>还没有拍摄档案</p>
      <p class="dim" style="font-size:12px;margin-top:6px">回到取景器拍一组，点「存档」就会出现在这里</p></div>`;
    return;
  }

  sessions.forEach((s, i) => {
    const best = s.frames.reduce((m, f) => Math.max(m, f.diag?.score || 0), 0);
    const thumb = s.finalShot?.thumb || s.frames[0]?.thumb || '';
    const card = document.createElement('div');
    card.className = 'review-card';
    card.style.animationDelay = `${Math.min(i * 0.05, 0.4)}s`;
    card.innerHTML = `
      ${thumb ? `<img class="thumb" src="${thumb}" alt="">` : '<div class="thumb"></div>'}
      <div class="meta">
        <div>
          <div class="meta-date mono">${fmtDate(s.startedAt)}</div>
          <div class="meta-sub mono">${s.frames.length} 帧诊断${s.finalShot ? ' · 有成片' : ''}</div>
        </div>
        <span class="score-pill ${best >= 75 ? 'good' : best >= 45 ? 'mid' : ''}">${best || '--'}</span>
      </div>`;
    card.addEventListener('click', () => openSession(s.id));
    list.appendChild(card);
  });
}

/* ---------- 会话详情 ---------- */

async function openSession(id) {
  const s = await store.getSession(id);
  if (!s) { toast('找不到这组档案', true); return; }
  currentSessionId = id;
  $('session-title').textContent = fmtDate(s.startedAt);

  const img = $('final-shot');
  img.src = s.finalShot?.dataUrl || s.frames[s.frames.length - 1]?.thumb || '';
  const best = s.frames.reduce((m, f) => Math.max(m, f.diag?.score || 0), 0);
  const fa = s.finalShot?.aspect;
  $('final-cap').textContent =
    `${s.finalShot ? '成片' : '末帧'} · ${s.frames.length} 帧诊断 · 最高分 ${best || '--'}` +
    (fa && fa !== '原始' ? ` · 画幅 ${fa}` : '') +
    (s.endedAt ? ` · ${Math.max(1, Math.round((s.endedAt - s.startedAt) / 1000))}s` : '');

  renderChart(s);
  renderTimeline(s);
  showView('session');
}

function renderChart(s) {
  const el = $('score-chart');
  const pts = s.frames.map((f, i) => ({ x: i, y: f.diag?.score || 0 }));
  const w = 640, h = 120, padX = 26, padY = 14;
  if (pts.length < 2) {
    el.innerHTML = `<p class="dim" style="font-size:12px;padding:8px">诊断帧不足，暂无曲线</p>`;
    return;
  }
  const maxX = Math.max(...pts.map((p) => p.x));
  const toXY = (p) => {
    const x = padX + (p.x / maxX) * (w - padX * 2);
    const y = h - padY - (p.y / 100) * (h - padY * 2);
    return [x.toFixed(1), y.toFixed(1)];
  };
  const line = pts.map(toXY).map((c) => c.join(',')).join(' ');
  const dots = pts.map((p) => {
    const [x, y] = toXY(p);
    return `<circle cx="${x}" cy="${y}" r="2.5" fill="#f2a007"/>`;
  }).join('');
  const g75 = (h - padY - (75 / 100) * (h - padY * 2)).toFixed(1);
  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;display:block">
      <line x1="${padX}" y1="${g75}" x2="${w - padX}" y2="${g75}" stroke="#2a2d27" stroke-dasharray="4 5"/>
      <text x="${w - padX}" y="${g75 - 5}" fill="#8b8e85" font-size="10" text-anchor="end">75</text>
      <polyline points="${line}" fill="none" stroke="#f2a007" stroke-width="2" stroke-linejoin="round"/>
      ${dots}
    </svg>`;
}

function renderTimeline(s) {
  const ol = $('timeline');
  ol.innerHTML = '';
  const items = s.frames.slice(-40);
  items.forEach((f) => {
    const d = f.diag || {};
    const li = document.createElement('li');
    li.className = d.done ? 'ok' : '';
    const t = new Date(f.ts);
    const p = (n) => String(n).padStart(2, '0');
    const extra = [];
    if (d.template) {
      const tpl = getTemplate(d.template);
      if (tpl) extra.push('灵感 · ' + tpl.name);
    }
    if (f.aspect && f.aspect !== '原始') extra.push(f.aspect);
    const chips = [...(d.issues || []), ...extra];
    li.innerHTML = `
      <div class="tl-head">
        <span class="tl-time mono">${p(t.getMinutes())}:${p(t.getSeconds())}</span>
        <span class="tl-score mono">${d.score ?? '--'}</span>
        ${d.done ? '<span class="tl-score mono" style="color:var(--ok)">✓ 可拍</span>' : ''}
      </div>
      <div class="tl-instr">${escapeHTML(d.instruction || '')}</div>
      ${chips.length ? `<div class="tl-issues">${chips.map((i) => `<span class="chip">${escapeHTML(i)}</span>`).join('')}</div>` : ''}`;
    ol.appendChild(li);
  });
  if (!items.length) ol.innerHTML = '<li><div class="tl-instr dim">本组没有诊断记录，只有成片</div></li>';
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------- 导出 / 删除 ---------- */

function onExport() {
  const btnText = '导出 JSON';
  store.getSession(currentSessionId).then((s) => {
    if (!s) { toast('找不到档案', true); return; }
    const data = {
      app: 'composition-coach',
      exportedAt: new Date().toISOString(),
      session: s,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `composition-session-${s.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出');
  });
}

/* ---------- 提升分享卡 ---------- */

async function onShareCard() {
  const s = await store.getSession(currentSessionId);
  if (!s) { toast('找不到档案', true); return; }
  if (!s.frames.length) { toast('这组还没有诊断记录，先去拍一组', true); return; }
  const btn = $('btn-sharecard');
  btn.disabled = true;
  try {
    const dataUrl = await buildShareCard(s);
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `composition-card-${s.id}.png`;
    a.click();
    toast('已生成提升卡 · 已开始下载');
  } catch (err) {
    toast('生成失败：' + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function onDelete() {
  if (!confirm('确定删除这组拍摄档案？此操作不可恢复。')) return;
  try {
    await store.deleteSession(currentSessionId);
    toast('已删除');
    showView('review');
  } catch (err) {
    toast('删除失败：' + err.message, true);
  }
}

/* ---------- 设置面板 ---------- */

function openSettings() {
  $('set-baseurl').value = settings.baseUrl;
  $('set-model').value = settings.model;
  $('set-key').value = settings.apiKey;
  $('set-interval').value = settings.intervalMs;
  $('set-auto').checked = !!settings.auto;
  $('interval-val').textContent = (settings.intervalMs / 1000).toFixed(2).replace(/0$/, '') + 's';
  markPreset(settings.preset);
  $('settings-modal').hidden = false;
}

function markPreset(key) {
  document.querySelectorAll('#preset-row button').forEach((b) => {
    b.classList.toggle('active', b.dataset.preset === key);
  });
}

function onSaveSettings() {
  const baseUrl = $('set-baseurl').value.trim().replace(/\/+$/, '');
  const model = $('set-model').value.trim();
  const apiKey = $('set-key').value.trim();
  const intervalMs = Number($('set-interval').value) || DEFAULT_SETTINGS.intervalMs;
  const auto = $('set-auto').checked;
  if (!baseUrl || !model) { toast('API 地址和模型名不能为空', true); return; }
  if (!apiKey) { toast('还需要填 API Key', true); return; }

  const activePreset = document.querySelector('#preset-row button.active');
  settings = {
    preset: activePreset?.dataset.preset || 'custom',
    baseUrl, model, apiKey, intervalMs, auto,
    inspiration: settings.inspiration !== false,
    ratio: settings.ratio || '',
    mode: settings.mode || 'auto',
    autoCapture: !!settings.autoCapture,
  };
  persistSettings();
  startLoop();
  $('settings-modal').hidden = true;
  toast('设置已保存，开始指导');
  if (camera.isReady()) setCoachIdle('正在观察取景框……');
}

async function onTestConnection() {
  const btn = $('btn-test');
  const backup = btn.textContent;
  btn.textContent = '测试中…';
  btn.disabled = true;
  try {
    // 生成一张 64px 测试图：不少视觉模型拒绝纯文本请求
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#8a8f85'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#f2a007'; g.fillRect(22, 22, 20, 20);
    const reply = await vlm.testConnection({
      baseUrl: $('set-baseurl').value.trim(),
      model: $('set-model').value.trim(),
      apiKey: $('set-key').value.trim(),
    }, c.toDataURL('image/jpeg', 0.6));
    toast('连接正常 · 模型回复：' + String(reply || '').slice(0, 30));
  } catch (err) {
    toast('连接失败：' + err.message, true);
  } finally {
    btn.textContent = backup;
    btn.disabled = false;
  }
}

/* ---------- 事件绑定 ---------- */

function bind() {
  $('btn-shutter').addEventListener('click', onShutter);
  $('btn-diagnose').addEventListener('click', diagnoseNow);
  $('btn-archive').addEventListener('click', onArchive);
  $('btn-retake').addEventListener('click', onRetake);
  $('btn-keep').addEventListener('click', onKeepShot);
  $('btn-review').addEventListener('click', () => showView('review'));
  $('btn-settings').addEventListener('click', openSettings);

  $('btn-flip').addEventListener('click', async () => {
    try {
      await startCamera(camera.flipFacing());
      reLayout();
    } catch (err) {
      toast('切换失败：' + err.message, true);
    }
  });

  $('btn-filter-toggle').addEventListener('click', () => {
    const row = $('filter-row');
    row.hidden = !row.hidden;
    $('btn-filter-toggle').classList.toggle('active', !row.hidden);
  });

  $('btn-local').addEventListener('click', toggleLocalCoach);
  $('btn-inspiration').addEventListener('click', toggleInspiration);
  $('btn-autocap').addEventListener('click', toggleAutoCap);

  // 姿态传感器：与实时教练解耦，常开；按屏幕方向取正确倾角轴并低通滤波
  window.addEventListener('deviceorientation', (e) => {
    if (!e || (e.gamma == null && e.beta == null)) return;
    orientationSeen = true;
    const angle = (screen.orientation && typeof screen.orientation.angle === 'number')
      ? screen.orientation.angle
      : (window.orientation || 0);
    let roll;
    if (angle === 90) roll = -e.beta;
    else if (angle === 270 || angle === -90) roll = e.beta;
    else roll = e.gamma;
    if (!Number.isFinite(roll)) return;
    rollFiltered = rollFiltered == null ? roll : rollFiltered * 0.75 + roll * 0.25;
    localcoach.setRoll(rollFiltered);
    overlay.setTilt(rollFiltered, true);
  });

  document.querySelectorAll('#zoom-row .zoom-pill[data-x]').forEach((b) => {
    b.addEventListener('click', () => {
      camera.zoomToTarget(Number(b.dataset.x)).then(syncZoomUI).catch(() => {});
    });
  });

  // iOS 式变焦手势：按住胶囊区左右拖动，浮现刻度变焦条，松手淡出
  const zoomRow = $('zoom-row');
  const zoomBar = $('zoom-bar');
  let zDrag = null;
  let barHideTimer = null;
  const showZoomBar = () => { zoomBar.classList.add('show'); clearTimeout(barHideTimer); };
  const scheduleHideZoomBar = () => {
    clearTimeout(barHideTimer);
    barHideTimer = setTimeout(() => zoomBar.classList.remove('show'), 1100);
  };

  zoomRow.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#btn-diagnose, #btn-local, #btn-inspiration, #btn-autocap, .filter-toggle')) return;
    const info = camera.zoomInfo();
    zDrag = { startX: e.clientX, startVal: Number(info.current), moved: false };
    showZoomBar();
    zoomRow.setPointerCapture(e.pointerId);
  });
  zoomRow.addEventListener('pointermove', (e) => {
    if (!zDrag) return;
    const dx = e.clientX - zDrag.startX;
    if (Math.abs(dx) > 6) zDrag.moved = true;
    if (!zDrag.moved) return;
    const info = camera.zoomInfo();
    const range = (info.max - info.min) || 1;
    let v = zDrag.startVal + (dx / 240) * range;
    for (const d of [0.5, 1, 2, 3, 4]) {
      if (d >= info.min && d <= info.max && Math.abs(v - d) < range * 0.035) { v = d; break; }
    }
    v = Math.min(info.max, Math.max(info.min, v));
    camera.setZoomValue(v).then(syncZoomUI).catch(() => {});
    scheduleHideZoomBar();
  });
  const endZoomDrag = (e) => {
    if (!zDrag) return;
    if (!zDrag.moved) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const pill = el && el.closest('#zoom-row .zoom-pill[data-x]');
      if (pill) {
        camera.zoomToTarget(Number(pill.dataset.x)).then(syncZoomUI).catch(() => {});
      }
    }
    zDrag = null;
    scheduleHideZoomBar();
  };
  zoomRow.addEventListener('pointerup', endZoomDrag);
  zoomRow.addEventListener('pointercancel', () => { zDrag = null; scheduleHideZoomBar(); });

  camera.onDigitalZoomChange(() => {
    reLayout();
    syncZoomUI();
  });

  document.querySelectorAll('[data-back]').forEach((b) => {
    b.addEventListener('click', () => {
      showView(document.body.dataset.view === 'session' ? 'review' : 'camera');
    });
  });

  document.querySelectorAll('[data-close-settings]').forEach((b) => {
    b.addEventListener('click', () => { $('settings-modal').hidden = true; });
  });

  document.querySelectorAll('#preset-row button').forEach((b) => {
    b.addEventListener('click', () => {
      markPreset(b.dataset.preset);
      const p = vlm.PRESETS[b.dataset.preset];
      if (p?.baseUrl) {
        $('set-baseurl').value = p.baseUrl;
        if (p.model) $('set-model').value = p.model;
      }
    });
  });

  $('set-interval').addEventListener('input', (e) => {
    const v = Number(e.target.value) / 1000;
    $('interval-val').textContent = v.toFixed(2).replace(/0$/, '') + 's';
  });

  $('btn-save-settings').addEventListener('click', onSaveSettings);
  $('btn-test').addEventListener('click', onTestConnection);
  $('btn-export').addEventListener('click', onExport);
  $('btn-sharecard').addEventListener('click', onShareCard);
  $('btn-delete').addEventListener('click', onDelete);

  window.addEventListener('resize', reLayout);
  video.addEventListener('loadedmetadata', reLayout);
  document.addEventListener('keydown', (e) => {
    if (document.body.dataset.view !== 'camera') return;
    if (e.code === 'Space') { e.preventDefault(); onShutter(); }
    if (e.code === 'KeyD') { e.preventDefault(); diagnoseNow(); }
  });
}

/* ---------- 启动 ---------- */

function init() {
  bind();
  reLayout();
  buildRatioRow();
  syncInspirationUI();
  buildModeRow();
  localcoach.setMode(settings.mode || 'auto');
  syncAutoCapUI();
  buildFilterRow();
  applyFilterToPreview();
  syncZoomUI();
  updateSessionTag();
  startLoop();
  startCamera('environment');
  restoreLastSession();

  // 姿态传感器可观测性：相机就绪 4s 内一条事件都没收到，
  // 大概率是非 HTTPS 安全上下文（deviceorientation 只在安全上下文触发）
  setTimeout(() => {
    if (!orientationSeen && document.body.dataset.view === 'camera') {
      toast('未收到姿态传感器数据，水平仪不可用（需 HTTPS 安全上下文）', true);
    }
  }, 4000);

  // 兜底持久化：切后台 / 关闭页面前把当前会话写盘
  window.addEventListener('pagehide', persistSessionNow);
  window.addEventListener('beforeunload', persistSessionNow);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) persistSessionNow();
  });
}

init();
