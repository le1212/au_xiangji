/* 相机模块：取景流管理、抓帧压缩、前后摄切换、变焦系统（硬件优先，不支持时退化数字变焦） */

const video = document.getElementById('video');

let stream = null;
let facing = 'environment';
let startError = null;

async function start(facingMode = facing) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('此浏览器不支持相机访问（需 HTTPS 或 localhost 环境）');
  }
  stop();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: facingMode,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
  facing = facingMode;
  video.srcObject = stream;
  await new Promise((resolve) => {
    if (video.readyState >= 2 && video.videoWidth > 0) return resolve();
    video.onloadedmetadata = () => resolve();
  });
  await video.play().catch(() => {});
  refreshVideoTransform();
  startError = null;
  return facing;
}

function stop() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

function isReady() {
  return !!stream && video.videoWidth > 0;
}

function getFacing() {
  return facing;
}

function getVideo() {
  return video;
}

function flipFacing() {
  return facing === 'environment' ? 'user' : 'environment';
}

/**
 * 抓一帧并缩放。filterCss 传入 CSS filter 字符串可把滤镜烘焙进成片。
 * 数字变焦时只取画面中心 1/dz 区域（与预览所见一致）；
 * aspect 传入目标画幅（宽/高，如 1、4/3、0.5625）时按该比例居中裁切，
 * 本函数只按传入值裁切；竖屏取倒（选 4:3 得 3:4 竖幅）由调用方的
 * effectiveAspect 决定；
 * maxEdge 传 Infinity 表示用原始分辨率（快门成片用）。
 * 返回 { dataUrl, thumb, w, h }。
 */
function capture(maxEdge = 640, quality = 0.72, thumbEdge = 200, filterCss = 'none', aspect = 0) {
  if (!isReady()) return null;
  const vw = video.videoWidth, vh = video.videoHeight;
  const dz = digitalZoom;
  let sw = Math.max(2, Math.round(vw / dz));
  let sh = Math.max(2, Math.round(vh / dz));
  let sx = Math.round((vw - sw) / 2);
  let sy = Math.round((vh - sh) / 2);

  if (aspect > 0) {
    const cur = sw / sh;
    if (cur > aspect) { const nw = Math.round(sh * aspect); sx += Math.round((sw - nw) / 2); sw = nw; }
    else if (cur < aspect) { const nh = Math.round(sw / aspect); sy += Math.round((sh - nh) / 2); sh = nh; }
  }

  // maxEdge=Infinity → 原始分辨率；再受画布面积上限保护（部分移动浏览器约 16.7M 像素）
  const MAX_PIXELS = 16e6;
  const area = sw * sh;
  let scale = maxEdge > 0 ? Math.min(1, maxEdge / Math.max(sw, sh)) : 1;
  if (area * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / area);
  const w = Math.max(2, Math.round(sw * scale));
  const h = Math.max(2, Math.round(sh * scale));

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (filterCss && filterCss !== 'none') ctx.filter = filterCss;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  const dataUrl = c.toDataURL('image/jpeg', quality);

  let thumb = null;
  const tscale = Math.min(1, thumbEdge / Math.max(w, h));
  if (tscale < 1) {
    const t = document.createElement('canvas');
    t.width = Math.round(w * tscale);
    t.height = Math.round(h * tscale);
    t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
    thumb = t.toDataURL('image/jpeg', 0.55);
  } else {
    thumb = dataUrl;
  }
  return { dataUrl, thumb, w, h };
}

/* ---------- 变焦（视角大小）系统 ----------
   硬件变焦优先；设备不支持时自动退化为数字变焦
   （预览中心裁切放大 + 成片同口径裁切），保证任何设备都有连续视角调节。 */

let digitalZoom = 1;
let dzListener = null;

function zoomCaps() {
  if (!isReady()) return null;
  const track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities ? track.getCapabilities() : null;
  if (!caps || !caps.zoom || caps.max <= caps.min) return null;
  return caps.zoom;
}

function zoomSupported() {
  return !!zoomCaps();
}

function getDigitalZoom() {
  return digitalZoom;
}

function onDigitalZoomChange(cb) {
  dzListener = cb;
}

function refreshVideoTransform() {
  const mirror = facing === 'user' ? 'scaleX(-1) ' : '';
  video.style.transform = digitalZoom > 1 ? mirror + `scale(${digitalZoom})` : mirror || 'none';
}

/** 视角信息（供 UI 展示） */
function zoomInfo() {
  const caps = zoomCaps();
  if (caps) {
    const track = stream.getVideoTracks()[0];
    return {
      hardware: true,
      min: caps.min,
      max: caps.max,
      step: caps.step || 0.1,
      current: track.getSettings().zoom ?? caps.min,
    };
  }
  return { hardware: false, min: 1, max: 4, step: 0.1, current: digitalZoom };
}

/** 把视角平滑变到目标倍率（硬件分步逼近；数字直接设定） */
async function zoomToTarget(multiplier) {
  const m = Math.min(4, Math.max(0.5, Number(multiplier) || 1));
  const caps = zoomCaps();
  if (caps) {
    const frac = (m - caps.min) / (caps.max - caps.min);
    const target = caps.min + (caps.max - caps.min) * Math.min(1, Math.max(0, frac));
    const track = stream.getVideoTracks()[0];
    const cur = track.getSettings().zoom ?? caps.min;
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const v = cur + (target - cur) * (i / steps);
      await track.applyConstraints({ advanced: [{ zoom: v }] });
      await new Promise((r) => setTimeout(r, 40));
    }
    return target;
  }
  digitalZoom = Math.min(4, Math.max(1, m));
  refreshVideoTransform();
  if (dzListener) dzListener(digitalZoom);
  return digitalZoom;
}

/** 即时设置变焦值（拖动跟手用，无动画） */
async function setZoomValue(v) {
  const caps = zoomCaps();
  if (caps) {
    const track = stream.getVideoTracks()[0];
    const target = Math.min(caps.max, Math.max(caps.min, Number(v)));
    await track.applyConstraints({ advanced: [{ zoom: target }] });
    return target;
  }
  digitalZoom = Math.min(4, Math.max(1, Number(v)));
  refreshVideoTransform();
  if (dzListener) dzListener(digitalZoom);
  return digitalZoom;
}

/** 步进变焦：dir 正=放大视角，负=缩小 */
async function stepZoom(dir) {
  const info = zoomInfo();
  const step = (info.max - info.min) * 0.15;
  return setZoomValue(Number(info.current) + dir * step);
}

export { start, stop, isReady, getFacing, getVideo, flipFacing, capture, zoomSupported, stepZoom, zoomInfo, zoomToTarget, setZoomValue, getDigitalZoom, onDigitalZoomChange };
