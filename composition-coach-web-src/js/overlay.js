/* 取景器叠加层：
   - 三分网格
   - 灵感构图模板层（templates.js 驱动，整层支持镜像翻转 + 6s 最短保持）
   - 当前位置框 / 目标引导框（蚂蚁线）+ 对齐辅助线 + 三分锚点 = 构图骨架
   - 主体移动箭头
   - 拍摄者动作卡：左移/右移、蹲低/举高、凑近/后退（或变焦）、旋转校正
   - 建议水平线 / 设备水平仪（姿态传感器驱动，绿色判定带滞回）
   - 达标绿色四角框 */

import { getTemplate } from './templates.js';

const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');

let W = 0, H = 0;
let diag = null;          // 归一化诊断数据（已映射镜像）
let mirrored = false;
let rafId = null;
let tiltDeg = null;       // 设备倾斜角（来自姿态传感器）
let tiltFreshUntil = 0;   // 此时间戳之前倾斜数据视为有效
let levelGreen = false;   // 水平仪滞回状态：进入绿色 ≤1.5°，退出需 >2°
let templateId = null;    // 当前灵感构图模板
let pendingTemplateId = null; // 建议切换的新模板（等保持期结束再生效）
let templateHoldUntil = 0;    // 当前模板最短保持到该时刻，防止连续诊断间来回换

const AMBER = '#f2a007';
const GREEN = '#6fdc8c';
const WHITE = 'rgba(232,230,222,0.92)';

/** 让画布精确覆盖视频可视区（object-fit: contain 黑边不算；
    数字变焦 dz>1 时只覆盖中心裁切出的可视部分；
    aspect>0 时先按目标画幅（宽/高）居中裁切，画布对齐裁切后的可视区）。
    返回画布实际覆盖的 stage 坐标矩形（供画幅遮罩定位）。 */
export function layout(stage, video, dz = 1, aspect = 0) {
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const va = vw / vh, sa = sw / sh;
  let w, h;
  if (sa > va) { h = sh; w = sh * va; } else { w = sw; h = sw / va; }
  let x = (sw - w) / 2, y = (sh - h) / 2;

  if (aspect > 0) {
    const cur = w / h;
    if (cur > aspect) { const nw = h * aspect; x += (w - nw) / 2; w = nw; }
    else if (cur < aspect) { const nh = w / aspect; y += (h - nh) / 2; h = nh; }
  }

  const vw2 = w / dz, vh2 = h / dz;
  const vx = x + (w - vw2) / 2, vy = y + (h - vh2) / 2;

  canvas.style.left = vx + 'px';
  canvas.style.top = vy + 'px';
  canvas.style.width = vw2 + 'px';
  canvas.style.height = vh2 + 'px';

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(2, Math.round(vw2 * dpr));
  canvas.height = Math.max(2, Math.round(vh2 * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  W = vw2; H = vh2;
  return { x: vx, y: vy, w: vw2, h: vh2 };
}

export function setMirror(m) {
  mirrored = !!m;
}

/** 前置摄像头时视频被 CSS 镜像：坐标与左右向动作做水平翻转以对齐用户所见 */
function mapRect(r) {
  if (!r) return null;
  if (!mirrored) return r;
  return { x: 1 - r.x - r.w, y: r.y, w: r.w, h: r.h };
}

export function setDiag(d) {
  const m = (d.move && typeof d.move === 'object') ? d.move : {};
  const num = (v, def = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  diag = {
    current: mapRect(d.current_frame),
    target: mapRect(d.target_frame),
    done: !!d.done,
    move: {
      dx: Math.max(-1, Math.min(1, num(m.dx))) * (mirrored ? -1 : 1),
      dy: Math.max(-1, Math.min(1, num(m.dy))),
      dz: Math.max(-1, Math.min(1, num(m.dz))),
    },
    zoom: d.zoom === 'in' || d.zoom === 'out' ? d.zoom : null,
    rotateDeg: Math.max(-15, Math.min(15, num(d.rotate_deg))),
    horizonY: (() => {
      const n = Number(d.horizon_y);
      return Number.isFinite(n) && n > 0.02 && n < 0.98 ? n : null;
    })(),
  };
  ensureLoop();
}

export function clear() {
  diag = null;
  templateId = null;
  pendingTemplateId = null;
  templateHoldUntil = 0;
  tiltFreshUntil = 0;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  ctx.clearRect(0, 0, W, H);
}

/** 更新设备倾斜角；fresh=false 表示数据过期（隐藏水平仪） */
export function setTilt(deg, fresh = true) {
  tiltDeg = Number(deg);
  tiltFreshUntil = fresh ? performance.now() + 3500 : 0;
  ensureLoop();
}

/** 灵感构图模板：带 6s 最短保持期，连续诊断间建议来回跳时先挂起 */
export function setTemplate(id) {
  const tpl = getTemplate(id);
  const next = tpl ? tpl.id : null;
  const now = performance.now();
  if (!next) {
    templateId = null;
    pendingTemplateId = null;
  } else if (next === templateId) {
    pendingTemplateId = null;
    templateHoldUntil = now + 6000;
  } else if (now >= templateHoldUntil) {
    templateId = next;
    pendingTemplateId = null;
    templateHoldUntil = now + 6000;
  } else {
    pendingTemplateId = next;
  }
  ensureLoop();
}

function ensureLoop() {
  if (!rafId) rafId = requestAnimationFrame(frame);
}

function frame(t) {
  rafId = null;
  const tiltActive = tiltFreshUntil > performance.now();
  if (!diag && !tiltActive && !templateId) { ctx.clearRect(0, 0, W, H); return; }
  draw(t);
  if (diag || tiltActive || templateId) ensureLoop();
  else ctx.clearRect(0, 0, W, H);
}

/* ================= 总绘制 ================= */

function draw(t) {
  ctx.clearRect(0, 0, W, H);
  drawThirds();
  drawTemplate();
  if (tiltFreshUntil > performance.now()) drawLevel(t);
  if (diag) {
    if (diag.done) {
      drawDone(t);
    } else {
      drawHorizon();
      drawCurrent();
      drawTarget(t);
      drawArrow();
      drawActionCard(t);
    }
  }
}

/* ================= 灵感构图模板层 ================= */

function drawTemplate() {
  // 保持期结束后，套用挂起中的新模板
  if (pendingTemplateId && performance.now() >= templateHoldUntil) {
    templateId = pendingTemplateId;
    pendingTemplateId = null;
    templateHoldUntil = performance.now() + 6000;
  }
  if (!templateId) return;
  const tpl = getTemplate(templateId);
  if (!tpl) return;
  ctx.save();
  // 前置镜像时整层水平翻转（文字提示统一在模板外画，避免翻转反字）
  if (mirrored) { ctx.translate(W, 0); ctx.scale(-1, 1); }
  tpl.draw(ctx, W, H);
  ctx.restore();
  label('灵感 · ' + tpl.name, W / 2 - 34, H - 24, AMBER);
}

function px(r) {
  return { x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H };
}

/* ================= 构图骨架 ================= */

function drawThirds() {
  ctx.save();
  ctx.strokeStyle = 'rgba(232,230,222,0.13)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i <= 2; i++) {
    ctx.moveTo(Math.round(W * i / 3) + 0.5, 0);
    ctx.lineTo(Math.round(W * i / 3) + 0.5, H);
    ctx.moveTo(0, Math.round(H * i / 3) + 0.5);
    ctx.lineTo(W, Math.round(H * i / 3) + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

/** 建议水平线：琥珀色虚线横贯画面 */
function drawHorizon() {
  if (diag.horizonY == null) return;
  const y = diag.horizonY * H;
  ctx.save();
  ctx.strokeStyle = 'rgba(242,160,7,0.75)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([14, 10]);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(W, y);
  ctx.stroke();
  ctx.setLineDash([]);
  // 两端短刻线
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(0, y - 7); ctx.lineTo(0, y + 7);
  ctx.moveTo(W, y - 7); ctx.lineTo(W, y + 7);
  ctx.stroke();
  ctx.restore();
  label('建议水平线', 8, y - 24, AMBER);
}

function drawTarget(t) {
  if (!diag.target) return;
  const { x, y, w, h } = px(diag.target);

  // 对齐辅助线：穿过目标框中心的水平/垂直细线（骨架）
  ctx.save();
  ctx.strokeStyle = 'rgba(242,160,7,0.28)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(0, y + h / 2); ctx.lineTo(W, y + h / 2);
  ctx.moveTo(x + w / 2, 0); ctx.lineTo(x + w / 2, H);
  ctx.stroke();
  ctx.restore();

  // 虚线蚂蚁线
  ctx.save();
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = 2.5;
  ctx.setLineDash([12, 8]);
  ctx.lineDashOffset = -((t / 40) % 20);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();

  // 四角实线刻块
  ctx.save();
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = 3.5;
  ctx.setLineDash([]);
  const L = Math.min(18, w / 3, h / 3);
  const corners = [
    [x, y, 1, 1], [x + w, y, -1, 1],
    [x, y + h, 1, -1], [x + w, y + h, -1, -1],
  ];
  ctx.beginPath();
  for (const [cx, cy, dx, dy] of corners) {
    ctx.moveTo(cx, cy + dy * L);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + dx * L, cy);
  }
  ctx.stroke();
  ctx.restore();

  // 三分锚点：目标框中心最近的三分交点画十字标记
  drawThirdsAnchor(x + w / 2, y + h / 2);

  label('目标位置', x, y - 24, AMBER);
}

function drawThirdsAnchor(cx, cy) {
  const gx = [W / 3, 2 * W / 3], gy = [H / 3, 2 * H / 3];
  let best = null, bestD = Infinity;
  for (const x of gx) for (const y of gy) {
    const d = Math.hypot(x - cx, y - cy);
    if (d < bestD) { bestD = d; best = { x, y }; }
  }
  if (!best) return;
  ctx.save();
  ctx.strokeStyle = AMBER;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1.5;
  const r = 10;
  ctx.beginPath();
  ctx.arc(best.x, best.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(best.x - r - 5, best.y); ctx.lineTo(best.x - r + 3, best.y);
  ctx.moveTo(best.x + r - 3, best.y); ctx.lineTo(best.x + r + 5, best.y);
  ctx.moveTo(best.x, best.y - r - 5); ctx.lineTo(best.x, best.y - r + 3);
  ctx.moveTo(best.x, best.y + r - 3); ctx.lineTo(best.x, best.y + r + 5);
  ctx.stroke();
  ctx.restore();
}

function drawCurrent() {
  if (!diag.current) return;
  const { x, y, w, h } = px(diag.current);
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.62)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
  label('当前位置', x, y - 22, WHITE);
}

/* ================= 主体移动箭头 ================= */

function drawArrow() {
  if (!diag.current || !diag.target) return;
  const c1 = px(diag.current), c2 = px(diag.target);
  const x1 = c1.x + c1.w / 2, y1 = c1.y + c1.h / 2;
  const x2 = c2.x + c2.w / 2, y2 = c2.y + c2.h / 2;
  const dist = Math.hypot(x2 - x1, y2 - y1);
  if (dist < 14) return;

  const sx = x1 + (x2 - x1) * 0.18;
  const sy = y1 + (y2 - y1) * 0.18;
  const ex = x1 + (x2 - x1) * 0.82;
  const ey = y1 + (y2 - y1) * 0.82;

  ctx.save();
  ctx.strokeStyle = 'rgba(242,160,7,0.92)';
  ctx.fillStyle = 'rgba(242,160,7,0.92)';
  ctx.lineWidth = 3;
  ctx.setLineDash([]);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();

  const ang = Math.atan2(ey - sy, ex - sx);
  arrowHead(ex, ey, ang, 11);
  ctx.restore();
}

function arrowHead(x, y, ang, size) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - size * Math.cos(ang - 0.44), y - size * Math.sin(ang - 0.44));
  ctx.lineTo(x - size * Math.cos(ang + 0.44), y - size * Math.sin(ang + 0.44));
  ctx.closePath();
  ctx.fill();
}

/* ================= 拍摄者动作卡 ================= */

function drawActionCard(t) {
  const m = diag.move || { dx: 0, dy: 0, dz: 0 };
  const rows = [];
  if (Math.abs(m.dx) >= 0.25) rows.push({ type: 'h', right: m.dx > 0, text: m.dx > 0 ? '向右移' : '向左移', strength: Math.abs(m.dx) });
  if (Math.abs(m.dy) >= 0.25) rows.push({ type: 'v', up: m.dy > 0, text: m.dy > 0 ? '举高手机' : '蹲低一点', strength: Math.abs(m.dy) });
  if (Math.abs(m.dz) >= 0.25) {
    rows.push({ type: m.dz > 0 ? 'in' : 'out', text: m.dz > 0 ? '凑近主体' : '往后退', strength: Math.abs(m.dz) });
  } else if (diag.zoom) {
    rows.push({ type: diag.zoom, text: diag.zoom === 'in' ? '变焦放大' : '变焦缩小', strength: 0.6 });
  }
  if (Math.abs(diag.rotateDeg) >= 0.8) {
    rows.push({ type: 'rot', cw: diag.rotateDeg > 0, text: `转 ${Math.abs(diag.rotateDeg).toFixed(0)}°`, strength: Math.min(1, Math.abs(diag.rotateDeg) / 8) });
  }
  if (!rows.length) return;

  const rowH = 34, pad = 10;
  const cardW = 118;
  const cardH = rows.length * rowH + pad * 2 - 6;
  const cx0 = 12;
  const cy0 = Math.max(64, H * 0.14);

  // 卡片底
  ctx.save();
  ctx.fillStyle = 'rgba(11,12,10,0.62)';
  ctx.strokeStyle = 'rgba(242,160,7,0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(cx0, cy0, cardW, cardH, 10) : ctx.rect(cx0, cy0, cardW, cardH);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  const pulse = 0.72 + 0.28 * Math.sin(t / 260);

  rows.forEach((row, i) => {
    const y = cy0 + pad + i * rowH + rowH / 2 - 3;
    ctx.save();
    ctx.globalAlpha = 0.65 + 0.35 * row.strength;

    if (row.type === 'h') {
      // 水平箭头：沿移动方向持续滑动
      const dir = row.right ? 1 : -1;
      const slide = -5 + ((t / 120) % 10);
      const xm = cx0 + 30;
      ctx.strokeStyle = WHITE;
      ctx.fillStyle = WHITE;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(xm - dir * 14 + dir * slide, y);
      ctx.lineTo(xm + dir * 10 + dir * slide, y);
      ctx.stroke();
      arrowHead(xm + dir * (14 + slide), y, dir > 0 ? 0 : Math.PI, 8);
      labelSmall(row.text, cx0 + 54, y + 4, WHITE);
    } else if (row.type === 'v') {
      // 垂直箭头：举高向上 / 蹲低向下，沿方向滑动
      const dir = row.up ? -1 : 1;
      const slide = -5 + ((t / 120) % 10);
      const xm = cx0 + 30;
      const ym = y;
      ctx.strokeStyle = WHITE;
      ctx.fillStyle = WHITE;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(xm, ym + dir * 10 + dir * slide);
      ctx.lineTo(xm, ym - dir * 12 + dir * slide);
      ctx.stroke();
      arrowHead(xm, ym - dir * (14 + slide), dir < 0 ? -Math.PI / 2 : Math.PI / 2, 8);
      labelSmall(row.text, cx0 + 54, y + 4, WHITE);
    } else if (row.type === 'in' || row.type === 'out') {
      // 双雪佛龙：凑近向内聚拢 / 后退向外张开，带节奏脉冲
      const xm = cx0 + 30;
      const s = row.type === 'out' ? -1 : 1;
      ctx.strokeStyle = WHITE;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      const grow = 2.5 * Math.sin(t / 240);
      for (let k = 0; k < 2; k++) {
        const phase = ((t / 500) + k * 0.5) % 1;
        ctx.globalAlpha = 0.45 + 0.55 * Math.sin(phase * Math.PI);
        const bx = xm + (k - 0.5) * 9 - s * grow * 0.5;
        ctx.beginPath();
        ctx.moveTo(bx - s * 5, y - 7);
        ctx.lineTo(bx + s * 3, y);
        ctx.lineTo(bx - s * 5, y + 7);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      labelSmall(row.text, cx0 + 54, y + 4, WHITE);
    } else if (row.type === 'rot') {
      // 旋转弧线箭头：沿建议方向持续扫描
      const xm = cx0 + 30, ym = y;
      const r = 11;
      const dir = row.cw ? 1 : -1;
      const start = row.cw ? -1.1 : Math.PI + 1.1;
      const a0 = start + dir * ((t / 300) % (Math.PI * 2));
      const a1 = a0 + dir * 2.2;
      ctx.strokeStyle = WHITE;
      ctx.fillStyle = WHITE;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(xm, ym, r, Math.min(a0, a1), Math.max(a0, a1));
      ctx.stroke();
      const hx = xm + r * Math.cos(a1), hy = ym + r * Math.sin(a1);
      arrowHead(hx, hy, a1 + dir * Math.PI / 2, 7);
      labelSmall(row.text, cx0 + 54, y + 4, WHITE);
    }
    ctx.restore();
  });
}

/* ---------- 水平仪（设备姿态驱动） ---------- */

function drawLevel(t) {
  const roll = Math.max(-45, Math.min(45, Number(tiltDeg) || 0));
  const cx = W / 2, cy = H / 2;
  const len = Math.min(W, H) * 0.22;
  // 滞回：进入绿色需 ≤1.5°，退出需 >2°，避免临界角反复闪烁
  levelGreen = levelGreen ? Math.abs(roll) <= 2 : Math.abs(roll) <= 1.5;
  const level = levelGreen;
  const color = level ? GREEN : 'rgba(255, 214, 10, 0.92)';

  // 屏幕固定的参考线
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - len, cy); ctx.lineTo(cx + len, cy);
  ctx.stroke();
  ctx.restore();

  // 随设备旋转的指示线 + 中心小圆
  const rad = -roll * Math.PI / 180;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rad);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-len * 0.72, 0); ctx.lineTo(len * 0.72, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  if (!level) label(`倾斜 ${Math.abs(roll).toFixed(1)}°`, cx - 36, cy + len * 0.5 + 8, color);
}

/* ================= 达标状态 ================= */

function drawDone(t) {
  const pad = Math.min(W, H) * 0.055;
  const len = Math.min(W, H) * 0.1;
  const alpha = 0.65 + 0.35 * Math.sin(t / 260);

  ctx.save();
  ctx.strokeStyle = GREEN;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 4;
  ctx.lineCap = 'square';
  ctx.beginPath();
  for (const [cx, cy, dx, dy] of [
    [pad, pad, 1, 1], [W - pad, pad, -1, 1],
    [pad, H - pad, 1, -1], [W - pad, H - pad, -1, -1],
  ]) {
    ctx.moveTo(cx, cy + dy * len);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + dx * len, cy);
  }
  ctx.stroke();
  ctx.restore();

  // 波纹：从画面中心一圈圈向外扩散
  const cx = W / 2, cy = H / 2;
  const maxR = Math.hypot(W, H) / 2;
  ctx.save();
  ctx.strokeStyle = GREEN;
  ctx.lineWidth = 2.5;
  for (let k = 0; k < 3; k++) {
    const p = ((t / 1500) + k / 3) % 1;
    ctx.globalAlpha = (1 - p) * 0.4;
    ctx.beginPath();
    ctx.arc(cx, cy, p * maxR, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/* ================= 小工具 ================= */

function label(text, x, y, color) {
  ctx.save();
  ctx.font = '600 12px "Chakra Petch","Noto Sans SC","Microsoft YaHei",sans-serif';
  const tw = ctx.measureText(text).width;
  const lx = Math.min(Math.max(4, x), W - tw - 16);
  const ly = Math.max(2, y);
  ctx.fillStyle = 'rgba(11,12,10,0.78)';
  ctx.fillRect(lx - 4, ly, tw + 8, 17);
  ctx.fillStyle = color;
  ctx.fillText(text, lx, ly + 13);
  ctx.restore();
}

function labelSmall(text, x, y, color) {
  ctx.font = '500 12px "Chakra Petch","Noto Sans SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle = 'rgba(11,12,10,0.55)';
  const tw = ctx.measureText(text).width;
  ctx.fillRect(x - 3, y - 11, tw + 6, 15);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
