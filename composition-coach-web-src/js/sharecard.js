/* 提升分享卡：把一次会话的构图分提升画成可保存的暗房风卡片（1080×1620 PNG）。
   画布色值与 overlay.js 同源：琥珀=强调、绿=达标、灰=读数、发丝线=分隔。 */

const AMBER = '#f2a007';
const GREEN = '#6fdc8c';
const DIM = '#8b8e85';
const LINE = '#2a2d27';
const TEXT = '#f5f5f7';
const FONT = "'Chakra Petch','Noto Sans SC','Microsoft YaHei',sans-serif";

const W = 1080, H = 1620, MARGIN = 100;

function loadImg(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/** contain 方式把图片画进矩形框，居中，画发丝线描边 */
function drawContained(ctx, img, x, y, w, h) {
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  if (!img) {
    ctx.fillStyle = DIM;
    ctx.font = `400 28px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('无成片', x + w / 2, y + h / 2);
    ctx.textAlign = 'left';
    return;
  }
  const s = Math.min(w / img.width, h / img.height);
  const dw = img.width * s, dh = img.height * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function drawScoreCurve(ctx, scores, x, y, w, h) {
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 10]);
  ctx.beginPath();
  const g75 = y + h - (75 / 100) * h;
  ctx.moveTo(x, g75);
  ctx.lineTo(x + w, g75);
  ctx.stroke();
  ctx.setLineDash([]);
  if (scores.length < 2) return;
  const maxX = scores.length - 1;
  const px = (i) => x + (i / maxX) * w;
  const py = (v) => y + h - (v / 100) * h;
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  scores.forEach((v, i) => {
    if (i === 0) ctx.moveTo(px(i), py(v));
    else ctx.lineTo(px(i), py(v));
  });
  ctx.stroke();
  for (let i = 0; i < scores.length; i++) {
    ctx.fillStyle = AMBER;
    ctx.beginPath();
    ctx.arc(px(i), py(scores[i]), 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 生成提升卡，返回 PNG dataURL；会话无诊断帧时返回 null */
export async function buildShareCard(session) {
  const frames = (session && session.frames) || [];
  if (!frames.length) return null;
  const scores = frames.map((f) => f.diag?.score || 0);
  const first = scores[0];
  const best = Math.max(...scores);
  const delta = best - first;
  const seconds = session.endedAt
    ? Math.max(1, Math.round((session.endedAt - session.startedAt) / 1000)) : null;

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  // 画布与面板
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#141613';
  ctx.fillRect(0, H - 120, W, 120);

  // 页眉：品牌 + 日期
  ctx.fillStyle = AMBER;
  ctx.font = `700 46px ${FONT}`;
  ctx.fillText('构图教练', MARGIN, 130);
  ctx.fillStyle = DIM;
  ctx.font = `400 28px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText(fmtDate(session.startedAt), W - MARGIN, 128);
  ctx.textAlign = 'left';

  // 封面成片
  const cover = await loadImg(session.finalShot?.thumb || frames[frames.length - 1].thumb);
  drawContained(ctx, cover, MARGIN, 200, W - MARGIN * 2, 640);

  // 分数读数：首帧 → 最佳
  const rowY = 1080;
  ctx.fillStyle = DIM;
  ctx.font = `400 26px ${FONT}`;
  ctx.fillText('首帧', MARGIN, rowY);
  ctx.fillStyle = TEXT;
  ctx.font = `700 120px ${FONT}`;
  ctx.fillText(String(first), MARGIN, rowY + 130);

  ctx.fillStyle = delta > 0 ? GREEN : DIM;
  ctx.font = `700 64px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(delta > 0 ? `+${delta}` : '±0', W / 2, rowY + 96);

  ctx.fillStyle = DIM;
  ctx.font = `400 26px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText('最佳', W - MARGIN, rowY);
  ctx.fillStyle = AMBER;
  ctx.font = `700 120px ${FONT}`;
  ctx.fillText(String(best), W - MARGIN, rowY + 130);
  ctx.textAlign = 'left';

  // 分数曲线
  ctx.fillStyle = DIM;
  ctx.font = `400 24px ${FONT}`;
  ctx.fillText('构图分轨迹', MARGIN, 1360);
  drawScoreCurve(ctx, scores, MARGIN, 1380, W - MARGIN * 2, 90);

  // 页脚
  const stat = `${frames.length} 帧诊断${seconds ? ` · ${seconds}s` : ''}`;
  ctx.fillStyle = DIM;
  ctx.font = `400 26px ${FONT}`;
  ctx.fillText(stat, MARGIN, H - 62);
  ctx.font = `400 22px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText('COMPOSITION COACH', W - MARGIN, H - 60);
  ctx.textAlign = 'left';

  return c.toDataURL('image/png');
}
