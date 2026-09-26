/* VLM 模块：构图诊断 prompt、OpenAI 兼容接口调用、JSON 解析与归一化 */

import { FILTERS } from './filters.js';

export const PRESETS = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash-vision-exp' },
  zhipu: { label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash' },
  dashscope: { label: '通义', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-flash' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  custom: { label: '自定义', baseUrl: '', model: '' },
};

/* 滤镜枚举从 filters.js 单一来源生成，id 与 UI 胶囊永远一致 */
const FILTER_PROMPT = FILTERS.map((f) => `${f.id}(${f.name}，${f.hint})`).join(' / ');
const FILTER_IDS = FILTERS.map((f) => f.id);

const PROMPT = `你是专业摄影构图教练，正在实时指导一位不懂摄影的人用手机拍摄。
画面主体可能是人物、物品、食物、建筑或风景中的焦点，请先判断主体类型再给建议。
分析这张取景画面，严格只输出一个 JSON 对象，不要输出任何解释、markdown 代码块或其他文字。
JSON 字段：
{
  "subject_type": "person、object、scene 三选一：人物 / 物品（含食物、产品、建筑局部）/ 场景（风光、街景等无单一主体）",
  "scene": "一句话描述画面主体与场景，不超过16字",
  "score": 构图质量分，0到100的整数,
  "issues": ["具体构图问题，最多3条，每条不超过10字"],
  "instruction": "给拍摄者的一条具体动作指令，不超过18字。必须是身体或手机动作，例如：往后退两步 / 蹲低一点 / 让主体往画面右边挪 / 手机顺时针转3度。禁止使用摄影术语。",
  "current_frame": 画面中主体当前所在的框，没有明确主体则填 null,
  "target_frame": 建议主体调整后应处的目标框，若构图已可拍摄则填 null,
  "move": 拍摄者为改善构图应该做的整体移动，格式 {"dx":数值,"dy":数值,"dz":数值}。取值-1~1：dx 负=向左移 正=向右移；dy 负=蹲低 正=举高手机；dz 负=后退 正=凑近主体。某方向不需要动就填 0,
  "zoom": "in"（建议拉近视角）、"out"（建议拉远视角）、null 三选一,
  "zoom_target": 建议的视角倍率，1~4 的数字（1=最广角，2=两倍视角，以此类推）；视角合适不用变就填 null,
  "rotate_deg": -15~15 的数字：建议手机旋转的角度（顺时针为正），用于把水平线转正；水平已正填 0,
  "horizon_y": 建议的水平线在画面中的高度，0~1 小数（0.5 附近常用于风光）；画面没有明显水平线时填 null,
  "template": 从这些 id 里选一个最适合当前画面的构图模板，作为灵感引导叠加到取景器：
    thirds(三分法,通用) / center(中心对称,建筑·正面人像) / diagonal(对角线,动态斜线) /
    triangle(三角形,多主体·静物组合) / leading(引导线,风光·道路·走廊纵深) /
    frame(框架式,门窗洞口做前景) / negative(负空间,极简大留白) / spiral(黄金螺旋,主体偏中心的自然画面)。
    画面已有明确构图或看不出更合适的填 null,
  "suggested_aspect": 当前画面更适合的成片画幅，"1:1"、"4:3"、"16:9"、"9:16"、"2.35:1" 五选一；
    竖屏成片由应用自动取倒（竖屏选 4:3 即 3:4 竖幅），因此不要返回 3:4；
    人物半身/全身常 4:3，美食俯拍常 1:1，风光常 16:9 或 2.35:1，街拍竖构图常 9:16；当前画幅已合适填 null,
  "suggested_filter": 从这些滤镜 id 里为当前画面的光线与氛围选最合适的一个：${FILTER_PROMPT}。填 id 字符串；色彩已合适或拿不准填 null,
  "filter_reason": "推荐该滤镜的一句话理由，不超过14字说人话，例如：逆光人像，提暖显肤色；没有推荐则填空字符串",
  "done": 构图是否已足够好、可以按快门，布尔值
}
框的坐标是相对画面宽高的 0~1 小数，格式 {"x":左上角x,"y":左上角y,"w":框宽,"h":框高}。
判断依据：主体位置与留白（三分法）、水平线是否歪斜、头顶或脚底是否被切、背景是否杂乱、光线方向；滤镜推荐看色温偏冷暖与饱和是否平淡。
拍物品时注意摆放位置、背景干净度与朝向留白（物体面向的方向留空间）；拍风光时注意水平线位置与前景兴趣点。
若画面模糊、过暗或没有有效主体，instruction 给出对应补救动作（如：太暗了，换个亮的地方），score 不超过 40，done 为 false。`;

/* 场景模式附加指导：拼在基底 prompt 后，让诊断偏向当前拍摄场景 */
const MODE_HINTS = {
  auto: '',
  person: '\n当前场景模式：拍人。优先判断：头顶或脚底是否被切、人物视线方向是否留白、肤色呈现是否自然；滤镜倾向柔和或暖阳；画幅常 4:3。',
  food: '\n当前场景模式：美食/静物。优先判断：背景是否干净、摆放朝向留白、俯拍角度是否端正；画幅常 1:1；滤镜倾向鲜明或柔和以提食欲。',
  scene: '\n当前场景模式：风光。优先判断：水平线是否水平、有无前景兴趣点、天空与地面比例；画幅常 16:9 或 2.35:1；滤镜倾向原图或冷调。',
};

export function buildPrompt(mode) {
  return PROMPT + (MODE_HINTS[mode] || '');
}

function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

function extractJSON(text) {
  if (!text) throw new Error('模型返回为空');
  let t = String(text).replace(/```json/gi, '```').replace(/```/g, '').trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s === -1 || e === -1 || e <= s) throw new Error('模型未返回 JSON');
  t = t.slice(s, e + 1);
  try {
    return JSON.parse(t);
  } catch {
    // 容错修复：模型常见的尾逗号 / NaN / undefined 问题
    const repaired = t
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/\bNaN\b/g, 'null')
      .replace(/\bundefined\b/g, 'null');
    try {
      return JSON.parse(repaired);
    } catch {
      throw new Error('模型返回的 JSON 无法解析');
    }
  }
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function parseRect(r) {
  if (!r || typeof r !== 'object') return null;
  const x = clamp01(r.x), y = clamp01(r.y);
  let w = clamp01(r.w), h = clamp01(r.h);
  if (x === null || y === null || !w || !h) return null;
  w = Math.min(w, 1 - x);
  h = Math.min(h, 1 - y);
  if (w < 0.02 || h < 0.02) return null;
  return { x, y, w, h };
}

function parseMove(m) {
  const o = (m && typeof m === 'object') ? m : {};
  const cl = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
  };
  return { dx: cl(o.dx), dy: cl(o.dy), dz: cl(o.dz) };
}

function parseRot(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-15, Math.min(15, n));
}

const TEMPLATE_IDS = ['thirds', 'center', 'diagonal', 'triangle', 'leading', 'frame', 'negative', 'spiral'];
const ASPECT_LABELS = ['1:1', '4:3', '16:9', '9:16', '2.35:1'];

export function normalizeDiag(raw) {
  const o = extractJSON(raw);
  const done = o.done === true;
  const score = Math.min(100, Math.max(0, Math.round(Number(o.score)) || 0));
  const subjectType = ['person', 'object', 'scene'].includes(o.subject_type) ? o.subject_type : '';
  return {
    subject_type: subjectType,
    scene: typeof o.scene === 'string' ? o.scene : '',
    score,
    issues: Array.isArray(o.issues) ? o.issues.filter((i) => typeof i === 'string' && i).slice(0, 3) : [],
    instruction: typeof o.instruction === 'string' && o.instruction ? o.instruction : (done ? '可以拍了' : '保持画面稳定'),
    current_frame: parseRect(o.current_frame),
    target_frame: done ? null : parseRect(o.target_frame),
    move: parseMove(o.move),
    zoom: o.zoom === 'in' || o.zoom === 'out' ? o.zoom : null,
    zoom_target: (() => {
      if (done) return null;
      const n = Number(o.zoom_target);
      if (!Number.isFinite(n) || n <= 0) return null;
      return Math.min(4, Math.max(1, n));
    })(),
    rotate_deg: done ? 0 : parseRot(o.rotate_deg),
    horizon_y: done ? null : clamp01(o.horizon_y),
    template: !done && TEMPLATE_IDS.includes(o.template) ? o.template : null,
    suggested_aspect: ASPECT_LABELS.includes(o.suggested_aspect) ? o.suggested_aspect : null,
    // 调色与构图独立：构图达标时滤镜建议仍然有效
    suggested_filter: FILTER_IDS.includes(o.suggested_filter) && o.suggested_filter !== 'none' ? o.suggested_filter : null,
    filter_reason: typeof o.filter_reason === 'string' ? o.filter_reason.trim().slice(0, 20) : '',
    done,
  };
}

function withTimeout(signal, ms) {
  try {
    const t = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([signal, t]) : t;
  } catch {
    return signal;
  }
}

async function chat(settings, body, signal, timeoutMs = 30000) {
  const url = trimSlash(settings.baseUrl) + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    signal: withTimeout(signal, timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (settings.apiKey || ''),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 160); } catch { /* ignore */ }
    throw new Error(`API ${res.status} ${res.statusText}${detail ? ' · ' + detail : ''}`);
  }
  const data = await res.json();
  const choice = data?.choices?.[0];
  const msg = choice?.message || {};
  let content = msg.content;
  // 部分服务商把内容放在数组里
  if (Array.isArray(content)) {
    content = content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  if (!content || !String(content).trim()) {
    // 推理模型可能把 token 全花在思考过程上，正文为空
    const hint = msg.reasoning_content ? '（token 被推理过程占用，已自动调大限额重试）' : '';
    throw new Error(`模型返回为空${choice?.finish_reason ? ' · finish_reason=' + choice.finish_reason : ''}${hint}`);
  }
  return content;
}

export async function analyzeFrame({ dataUrl, settings, signal, mode = 'auto' }) {
  // 任何失败自动重试一次（第二次加大 max_tokens）：
  // 覆盖推理型模型正文为空（finish_reason=length）与网络抖动两类情况
  const attempts = [1200, 4000];
  let lastErr = null;
  for (const maxTokens of attempts) {
    try {
      const text = await chat(settings, {
        model: settings.model,
        max_tokens: maxTokens,
        temperature: 0.3,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: buildPrompt(mode) },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
      }, signal, 45000);
      return normalizeDiag(text);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function testConnection(settings, imageDataUrl) {
  // 带上一张真实小图：不少视觉模型会拒绝纯文本请求，导致"测试失败"误报
  const content = [{ type: 'text', text: '连通性测试。这是一张测试图片，请直接回复两个字：正常' }];
  if (imageDataUrl) {
    content.push({ type: 'image_url', image_url: { url: imageDataUrl } });
  }
  const text = await chat(settings, {
    model: settings.model,
    max_tokens: 1000,
    messages: [{ role: 'user', content }],
  }, undefined, 25000);
  return text;
}
