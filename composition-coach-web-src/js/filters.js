/* 滤镜预设：预览（video style.filter）与成片（canvas ctx.filter）共用同一份定义，
   保证"所见即所得"。hint 是适用场景描述，供 VLM prompt 与 AI 推荐共用。 */

export const FILTERS = [
  { id: 'none',  name: '原图', css: 'none', hint: '色彩已合适' },
  { id: 'vivid', name: '鲜明', css: 'saturate(1.35) contrast(1.08)', hint: '色彩平淡欠饱和' },
  { id: 'warm',  name: '暖阳', css: 'sepia(0.28) saturate(1.25) brightness(1.05)', hint: '画面偏冷或人像提暖' },
  { id: 'cool',  name: '冷调', css: 'hue-rotate(-14deg) saturate(1.12) brightness(1.03)', hint: '暖光过闷或蓝调夜景' },
  { id: 'mono',  name: '黑白', css: 'grayscale(1) contrast(1.12)', hint: '背景杂乱或光影对比强' },
  { id: 'film',  name: '胶片', css: 'sepia(0.42) contrast(1.16) saturate(0.88) brightness(0.98)', hint: '复古怀旧氛围' },
  { id: 'soft',  name: '柔和', css: 'brightness(1.08) saturate(0.92)', hint: '人像柔化肤色' },
];

const LS_KEY = 'cc-filter';

export function getSavedFilterId() {
  try {
    const id = localStorage.getItem(LS_KEY);
    return FILTERS.some((f) => f.id === id) ? id : 'none';
  } catch {
    return 'none';
  }
}

export function saveFilterId(id) {
  try { localStorage.setItem(LS_KEY, id); } catch { /* ignore */ }
}

export function getFilterCss(id) {
  return (FILTERS.find((f) => f.id === id) || FILTERS[0]).css;
}

/** 给 dataURL 图片烘焙滤镜，返回带滤镜的新 dataURL */
export function bakeFilter(dataUrl, cssFilter) {
  return new Promise((resolve) => {
    if (!cssFilter || cssFilter === 'none') return resolve(dataUrl);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.filter = cssFilter;
      ctx.drawImage(img, 0, 0);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
