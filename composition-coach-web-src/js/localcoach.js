/* 端侧实时教练（华为式体验的浏览器复刻）：
   MediaPipe 本地推理（人脸/物体检测）+ 构图规则引擎（场景模式）+ 设备倾角参与评分。
   全程离线、零网络成本、低延迟；云端深度诊断结果在短保持期内优先（见 app.js CLOUD_HOLD_MS）。 */

import { FilesetResolver, FaceDetector, ObjectDetector } from '../vendor/mediapipe/vision_bundle.mjs';

let faceDetector = null;
let objectDetector = null;
let initialized = false;
let initPromise = null;

let running = false;
let rafId = null;
let video = null;
let onResult = null;

let lastVideoTime = -1;
let ema = null;            // 平滑后的主体框（归一化）
let emaAt = 0;             // 最近一次检测到主体的时刻（丢失保持用）
let lastEmit = null;       // 上次发出的结果（用于变化检测）
let lastEmitAt = 0;
let objCooldown = 0;
let rollDeg = 0;           // 设备倾斜角（拍照横向水平）
let lockedAnchor = null;   // 锁定的三分锚点（滞回，防目标框跳对角）
let doneState = false;     // 达标滞回（施密特触发，防"可以拍"闪烁）
let lastInstruction = '';  // 文案稳定窗：同一指令至少保持 800ms
let instructionAt = 0;
let lastSubjectType = 'object'; // 丢失保持期内沿用最近一次检出的主体类型

const EMA_A = 0.18;        // 平滑系数：新值占比，越小越稳
const COAST_MS = 500;      // 检测丢失后保留上一框的时长

/* 场景模式规则参数：锚点策略 / 物体主体尺寸域 / 水平达标阈值（度） */
const MODES = {
  auto:   { anchor: 'thirds', objMin: 0.05, objMax: 0.55, rollEnter: 3,   rollExit: 4 },
  person: { anchor: 'thirds', objMin: 0.05, objMax: 0.55, rollEnter: 3,   rollExit: 4 },
  food:   { anchor: 'center', objMin: 0.08, objMax: 0.65, rollEnter: 3,   rollExit: 4 },
  scene:  { anchor: 'thirds', objMin: 0.02, objMax: 0.70, rollEnter: 2,   rollExit: 3.5 },
};
let mode = 'auto';

/** 切换场景模式：重置锚点滞回与达标状态，避免沿用上一模式的判定轨迹 */
export function setMode(m) {
  if (!MODES[m] || m === mode) return;
  mode = m;
  lockedAnchor = null;
  doneState = false;
}

export async function init() {
  if (initialized) return true;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const fileset = await FilesetResolver.forVisionTasks('vendor/mediapipe/wasm');
    const make = (delegate) => FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: 'model/blaze_face_short_range.tflite', delegate },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.5,
    });
    try { faceDetector = await make('GPU'); } catch { faceDetector = await make('CPU'); }
    try {
      objectDetector = await ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: 'model/efficientdet_lite0.tflite', delegate: 'CPU' },
        runningMode: 'VIDEO',
        scoreThreshold: 0.45,
        maxResults: 5,
      });
    } catch { objectDetector = null; }
    initialized = true;
  })();
  return initPromise;
}

export function setRoll(deg) {
  const n = Number(deg);
  if (Number.isFinite(n)) rollDeg = n;
}

export function start(v, cb) {
  video = v;
  onResult = cb;
  if (!running) {
    running = true;
    lastVideoTime = -1;
    ema = null;
    emaAt = 0;
    lastEmit = null;
    lastEmitAt = 0;
    lockedAnchor = null;
    doneState = false;
    lastInstruction = '';
    instructionAt = 0;
    rafId = requestAnimationFrame(loop);
  }
}

export function stop() {
  running = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  ema = null;
  emaAt = 0;
  lastEmit = null;
  lastEmitAt = 0;
  lockedAnchor = null;
  doneState = false;
}

function loop() {
  if (!running) return;
  rafId = requestAnimationFrame(loop);
  if (!video || video.readyState < 2) return;
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  try { detect(); } catch { /* 单帧错误忽略 */ }
}

function detect() {
  let box = null;
  let subjectType = 'object';

  if (faceDetector) {
    const res = faceDetector.detectForVideo(video, performance.now());
    let best = null, bestA = 0;
    for (const d of res?.detections || []) {
      const b = d.boundingBox;
      const a = (b.width / video.videoWidth) * (b.height / video.videoHeight);
      if (a > bestA) { bestA = a; best = b; }
    }
    if (best) {
      subjectType = 'person';
      box = {
        x: best.originX / video.videoWidth,
        y: best.originY / video.videoHeight,
        w: best.width / video.videoWidth,
        h: best.height / video.videoHeight,
      };
    }
  }

  if (!box && objectDetector && performance.now() - objCooldown > 400) {
    objCooldown = performance.now();
    const res = objectDetector.detectForVideo(video, performance.now());
    let best = null, bestA = 0;
    for (const d of res?.detections || []) {
      const b = d.boundingBox;
      const a = (b.width / video.videoWidth) * (b.height / video.videoHeight);
      if (a > bestA) { bestA = a; best = b; }
    }
    if (best) {
      subjectType = 'object';
      box = {
        x: best.originX / video.videoWidth,
        y: best.originY / video.videoHeight,
        w: best.width / video.videoWidth,
        h: best.height / video.videoHeight,
      };
    }
  }

  // 指数平滑抑制检测抖动；短暂丢失（<500ms）时保持上一框，
  // 避免整组引导框闪烁；持续丢失才清空并解锁锚点
  const now = performance.now();
  if (box) {
    lastSubjectType = subjectType;
    ema = ema ? {
      x: ema.x * (1 - EMA_A) + box.x * EMA_A,
      y: ema.y * (1 - EMA_A) + box.y * EMA_A,
      w: ema.w * (1 - EMA_A) + box.w * EMA_A,
      h: ema.h * (1 - EMA_A) + box.h * EMA_A,
    } : box;
    emaAt = now;
  } else if (ema && now - emaAt < COAST_MS) {
    /* 保持期内沿用旧框 */
  } else {
    if (ema) { lockedAnchor = null; doneState = false; }
    ema = null;
  }

  // 保持期内沿用丢失前的主体类型：detect 每帧都会把 subjectType 重置为
  // 'object'，若直接透传，人脸短暂丢失时对象阈值会反噬人脸框造成抖动
  const diag = evaluate(ema, box ? subjectType : lastSubjectType);
  if (diag && shouldEmit(diag) && onResult) {
    lastEmit = diag;
    lastEmitAt = now;
    onResult(diag);
  }
}

/* ---------- 构图规则引擎 ---------- */

/** 最近三分交点 + 滞回：新锚点要比锁定锚点近四成以上才切换，
    主体在画面中心附近时临界抖动不再导致目标框跳对角 */
function pickAnchor(cx, cy) {
  const gx = [1 / 3, 2 / 3], gy = [1 / 3, 2 / 3];
  let nearest = null, nd = Infinity;
  for (const x of gx) for (const y of gy) {
    const d = Math.hypot(x - cx, y - cy);
    if (d < nd) { nd = d; nearest = { x, y }; }
  }
  if (!lockedAnchor) { lockedAnchor = nearest; return nearest; }
  const ld = Math.hypot(lockedAnchor.x - cx, lockedAnchor.y - cy);
  if (nd < ld * 0.6) lockedAnchor = nearest;
  return lockedAnchor;
}

/** 本地兜底模板推荐：按主体类型与大小映射（可颂式灵感的离线降级） */
function pickLocalTemplate(subjectType, size, cx) {
  if (subjectType === 'person') return size > 0.12 ? 'center' : 'thirds';
  if (subjectType === 'object') return size < 0.08 ? 'negative' : 'center';
  return (cx < 0.4 || cx > 0.6) ? 'diagonal' : 'leading';
}

/** 文案稳定窗：同一指令至少停留 800ms 才允许换，消除手抖导致的左右横跳 */
function stableInstruction(text) {
  const now = performance.now();
  if (text !== lastInstruction && now - instructionAt >= 800) {
    lastInstruction = text;
    instructionAt = now;
  }
  return lastInstruction || text;
}

function evaluate(box, subjectType) {
  if (!box) return null;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

  const cfg = MODES[mode] || MODES.auto;
  const anchor = cfg.anchor === 'center' ? { x: 0.5, y: 0.5 } : pickAnchor(cx, cy);
  const bestD = Math.hypot(anchor.x - cx, anchor.y - cy);

  const size = box.w * box.h;
  const minSize = subjectType === 'person' ? 0.03 : cfg.objMin;
  const maxSize = subjectType === 'person' ? 0.30 : cfg.objMax;

  const roll = Math.abs(rollDeg);
  const sizePenalty = size < minSize ? (minSize - size) * 400
                    : size > maxSize ? (size - maxSize) * 120 : 0;
  const rollPenalty = roll > cfg.rollEnter ? Math.min(30, (roll - cfg.rollEnter) * 5) : 0;
  const offsetPenalty = bestD * 200;

  const score = Math.max(0, Math.min(100, Math.round(
    100 - offsetPenalty - sizePenalty - rollPenalty
  )));

  const sizeOk = size >= minSize && size <= maxSize;
  // 施密特触发：进入达标与退出达标用不同阈值，手持微晃不再让"可以拍"闪烁
  const enterDone = bestD < 0.08 && sizeOk && roll <= cfg.rollEnter;
  const exitDone = bestD > 0.11 || roll > cfg.rollExit || !sizeOk;
  doneState = doneState ? !exitDone : enterDone;
  const done = doneState;

  // 目标框：主体平移到锚点
  const target_frame = {
    x: anchor ? box.x + (anchor.x - cx) : box.x,
    y: anchor ? box.y + (anchor.y - cy) : box.y,
    w: box.w, h: box.h,
  };

  const issues = [];
  if (Math.abs(cx - 0.5) > 0.06) issues.push(cx < 0.5 ? '主体偏左' : '主体偏右');
  if (size < minSize) issues.push('主体太小');
  if (size > maxSize) issues.push('主体太满');
  if (roll > cfg.rollEnter) issues.push('画面倾斜');

  let instruction;
  if (done) {
    instruction = '✓ 本机实时：构图达标，可以拍了';
    lastInstruction = instruction;
    instructionAt = performance.now();
  } else if (roll > cfg.rollEnter) {
    instruction = `画面倾斜 ${roll.toFixed(0)}°，转正手机`;
    lastInstruction = instruction;
    instructionAt = performance.now();
  } else if (size < minSize) {
    instruction = '靠近一点，主体太小了';
    lastInstruction = instruction;
    instructionAt = performance.now();
  } else if (size > maxSize) {
    instruction = '退远一点，主体太满了';
    lastInstruction = instruction;
    instructionAt = performance.now();
  } else if (anchor) {
    const dx = anchor.x - cx;
    const dy = anchor.y - cy;
    // 死区从 0.03/0.04 放宽到 0.06/0.08，高于手持自然晃动幅度
    const parts = [];
    parts.push(Math.abs(dx) > 0.06 ? `主体往${dx > 0 ? '右' : '左'}挪` : '保持左右');
    if (Math.abs(dy) > 0.08) parts.push(dy > 0 ? '手机举高' : '蹲低一点');
    instruction = stableInstruction(parts.slice(0, 2).join('，'));
  } else {
    instruction = '保持画面稳定';
  }

  return {
    subject_type: subjectType === 'person' ? 'person' : 'object',
    scene: '本机实时分析',
    score,
    issues: issues.slice(0, 2),
    instruction,
    current_frame: box,
    target_frame: done ? null : target_frame,
    move: { dx: 0, dy: 0, dz: 0 },
    zoom: null,
    zoom_target: null,
    rotate_deg: 0,
    horizon_y: null,
    template: pickLocalTemplate(subjectType, size, cx),
    suggested_aspect: null,
    suggested_filter: null,   // 本地不做调色判断，留给云端 VLM
    filter_reason: '',
    done,
    local: true,
  };
}

function shouldEmit(diag) {
  if (!lastEmit) return true;
  // 关键变化立即发；其余变化限流到 350ms 一条，文案与框不再刷屏
  if (diag.done !== lastEmit.done) return true;
  if (Math.abs(diag.score - lastEmit.score) >= 8) return true;
  if (performance.now() - lastEmitAt < 350) return false;
  if (diag.instruction !== lastEmit.instruction) return true;
  if (diag.template !== lastEmit.template) return true;
  const a = diag.current_frame, b = lastEmit.current_frame;
  if (!a !== !b) return true;
  if (a && b && Math.hypot(a.x - b.x, a.y - b.y) > 0.05) return true;
  return false;
}
