/* 灵感构图模板库（可颂式按场景推荐）：
   每个模板只负责在取景器上画"构图骨架"，坐标归一化到画布 W×H。
   VLM 按场景推荐 id（vlm.js PROMPT 枚举与这里一致），无云端时由 localcoach 按主体类型兜底。
   前置镜像时 overlay 层对非对称模板做水平翻转，绘制函数无需关心镜像。 */

const AMBER = 'rgba(242,160,7,';

function dashedLine(ctx, x1, y1, x2, y2, dash = [8, 8]) {
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);
}

function dot(ctx, x, y, r = 5) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
}

export const TEMPLATES = {
  /* 三分法：加粗三分线 + 四个交点强调圈 */
  thirds: {
    id: 'thirds',
    name: '三分法',
    hint: '通用 · 主体放三分交点',
    draw(ctx, W, H) {
      ctx.strokeStyle = AMBER + '0.5)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let i = 1; i <= 2; i++) {
        ctx.moveTo(W * i / 3, 0); ctx.lineTo(W * i / 3, H);
        ctx.moveTo(0, H * i / 3); ctx.lineTo(W, H * i / 3);
      }
      ctx.stroke();
      ctx.strokeStyle = AMBER + '0.75)';
      for (const x of [W / 3, 2 * W / 3]) for (const y of [H / 3, 2 * H / 3]) dot(ctx, x, y, 6);
    },
  },

  /* 中心对称：中轴十字 + 中央同心圆 */
  center: {
    id: 'center',
    name: '中心对称',
    hint: '建筑 · 正面人像 · 对称画面',
    draw(ctx, W, H) {
      ctx.strokeStyle = AMBER + '0.55)';
      ctx.lineWidth = 1.4;
      dashedLine(ctx, W / 2, 0, W / 2, H);
      dashedLine(ctx, 0, H / 2, W, H / 2);
      ctx.strokeStyle = AMBER + '0.7)';
      dot(ctx, W / 2, H / 2, Math.min(W, H) * 0.08);
      ctx.globalAlpha = 0.45;
      dot(ctx, W / 2, H / 2, Math.min(W, H) * 0.16);
      ctx.globalAlpha = 1;
    },
  },

  /* 对角线：两条对角线 + 中心交点 */
  diagonal: {
    id: 'diagonal',
    name: '对角线',
    hint: '动态 · 斜线 · 延伸感画面',
    draw(ctx, W, H) {
      ctx.strokeStyle = AMBER + '0.5)';
      ctx.lineWidth = 1.4;
      dashedLine(ctx, 0, 0, W, H);
      dashedLine(ctx, W, 0, 0, H);
      ctx.strokeStyle = AMBER + '0.75)';
      dot(ctx, W / 2, H / 2, 6);
    },
  },

  /* 三角形：中央倒三角参考（稳定/多主体组合） */
  triangle: {
    id: 'triangle',
    name: '三角形',
    hint: '多主体 · 静物组合',
    draw(ctx, W, H) {
      ctx.strokeStyle = AMBER + '0.55)';
      ctx.lineWidth = 1.4;
      const p = [
        [W * 0.2, H * 0.8],
        [W * 0.8, H * 0.8],
        [W * 0.5, H * 0.22],
      ];
      ctx.beginPath();
      ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i <= 3; i++) ctx.lineTo(p[i % 3][0], p[i % 3][1]);
      ctx.stroke();
      ctx.strokeStyle = AMBER + '0.75)';
      for (const [x, y] of p) dot(ctx, x, y, 6);
    },
  },

  /* 引导线：四边向消失点汇聚（风光/走廊/道路） */
  leading: {
    id: 'leading',
    name: '引导线',
    hint: '风光 · 道路 · 走廊纵深',
    draw(ctx, W, H) {
      const vx = W / 2, vy = H * 0.44;
      ctx.strokeStyle = AMBER + '0.45)';
      ctx.lineWidth = 1.3;
      dashedLine(ctx, 0, H, vx, vy, [6, 8]);
      dashedLine(ctx, W, H, vx, vy, [6, 8]);
      dashedLine(ctx, 0, H * 0.55, vx, vy, [6, 8]);
      dashedLine(ctx, W, H * 0.55, vx, vy, [6, 8]);
      ctx.strokeStyle = AMBER + '0.8)';
      dot(ctx, vx, vy, 7);
    },
  },

  /* 框架式：内缩框角提示（门窗洞口做前景框架） */
  frame: {
    id: 'frame',
    name: '框架式',
    hint: '门窗 · 洞口 · 前景框架',
    draw(ctx, W, H) {
      const inx = W * 0.14, iny = H * 0.14;
      const L = Math.min(W, H) * 0.09;
      ctx.strokeStyle = AMBER + '0.65)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [cx, cy, dx, dy] of [
        [inx, iny, 1, 1], [W - inx, iny, -1, 1],
        [inx, H - iny, 1, -1], [W - inx, H - iny, -1, -1],
      ]) {
        ctx.moveTo(cx, cy + dy * L);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + dx * L, cy);
      }
      ctx.stroke();
      ctx.strokeStyle = AMBER + '0.28)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 7]);
      ctx.strokeRect(inx, iny, W - inx * 2, H - iny * 2);
      ctx.setLineDash([]);
    },
  },

  /* 负空间：主体占一侧三分之一，另一侧大面积留白（虚线圈提示留白区） */
  negative: {
    id: 'negative',
    name: '负空间',
    hint: '极简 · 大留白 · 孤立主体',
    draw(ctx, W, H) {
      ctx.strokeStyle = AMBER + '0.55)';
      ctx.lineWidth = 1.4;
      dashedLine(ctx, W / 3, 0, W / 3, H);
      ctx.strokeStyle = AMBER + '0.5)';
      ctx.setLineDash([3, 6]);
      ctx.beginPath();
      ctx.arc(W * (1 / 3 + (2 / 3) * 0.5), H * 0.48, Math.min(W, H) * 0.11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      // 留白区四条短刻线，指明"这片留给空气感"
      ctx.strokeStyle = AMBER + '0.65)';
      ctx.lineWidth = 1.6;
      const sx = W * (1 / 3 + (2 / 3) * 0.5), sy = H * 0.48, rr = Math.min(W, H) * 0.16;
      ctx.beginPath();
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        ctx.moveTo(sx + dx * rr, sy + dy * rr);
        ctx.lineTo(sx + dx * (rr + 8), sy + dy * (rr + 8));
      }
      ctx.stroke();
    },
  },

  /* 黄金螺旋：内接黄金矩形 + 内旋四分之一圆弧 */
  spiral: {
    id: 'spiral',
    name: '黄金螺旋',
    hint: '主体偏中心的自然画面',
    draw(ctx, W, H) {
      const phi = (1 + Math.sqrt(5)) / 2;
      // 内接黄金矩形
      let r;
      if (W / H > phi) {
        const w = H * phi;
        r = { x: (W - w) / 2, y: 0, w, h: H };
      } else {
        const h = W / phi;
        r = { x: 0, y: (H - h) / 2, w: W, h };
      }
      ctx.strokeStyle = AMBER + '0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      // 依次切正方形（左→上→右→底内旋），每个正方形内画四分之一圆弧
      ctx.strokeStyle = AMBER + '0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const sides = ['left', 'top', 'right', 'bottom'];
      for (let i = 0; i < 8 && r.w > 10 && r.h > 10; i++) {
        const side = sides[i % 4];
        let s, sx, sy, cx, cy, a0;
        if (side === 'left') {
          s = r.h; sx = r.x; sy = r.y;
          r = { x: r.x + s, y: r.y, w: r.w - s, h: r.h };
          cx = sx + s; cy = sy + s; a0 = Math.PI;             // 弧: 左边中点 → 顶边
        } else if (side === 'top') {
          s = r.w; sx = r.x; sy = r.y;
          r = { x: r.x, y: r.y + s, w: r.w, h: r.h - s };
          cx = sx; cy = sy + s; a0 = -Math.PI / 2;            // 顶边 → 右边
        } else if (side === 'right') {
          s = r.h; sx = r.x + r.w - s; sy = r.y;
          r = { x: r.x, y: r.y, w: r.w - s, h: r.h };
          cx = sx; cy = sy; a0 = 0;                            // 右边 → 底边
        } else {
          s = r.w; sx = r.x; sy = r.y + r.h - s;
          r = { x: r.x, y: r.y, w: r.w, h: r.h - s };
          cx = sx + s; cy = sy; a0 = Math.PI / 2;             // 底边 → 左边
        }
        ctx.moveTo(cx + s * Math.cos(a0), cy + s * Math.sin(a0));
        ctx.arc(cx, cy, s, a0, a0 + Math.PI / 2);
      }
      ctx.stroke();
    },
  },
};

/** 按 id 取模板，未知 id 返回 null（VLM 返回与存档数据不可信时的兜底）。
    返回 { id, name, hint, draw(ctx, W, H) } */
export function getTemplate(id) {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, id) ? TEMPLATES[id] : null;
}

/** 全部模板 id，需与 vlm.js PROMPT 里的枚举保持一致 */
export const TEMPLATE_IDS = Object.keys(TEMPLATES);
