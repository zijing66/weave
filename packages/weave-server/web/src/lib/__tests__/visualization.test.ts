import { describe, expect, it } from 'vitest';
import { materialize, visualizationHeightCap } from '../visualization';

const VARS = {
  '--w-neutral-950': '10 10 10',
  '--w-neutral-50': '250 250 250',
  '--w-neutral-900': '23 23 23',
  '--w-neutral-800': '38 38 38',
  '--w-neutral-400': '163 163 163',
  '--w-neutral-700': '64 64 64',
  '--w-blue-500': '59 130 246',
  '--w-red-500': '239 68 68',
  '--w-emerald-500': '16 185 129',
  '--w-amber-500': '245 158 11',
  '--w-sky-500': '14 165 233',
  '--w-neutral-100': '245 245 245',
  '--w-neutral-200': '229 229 229',
  '--w-neutral-500': '115 115 115',
};

describe('visualizationHeightCap', () => {
  it('块再高也不超过气泡区的 70%', () => {
    expect(visualizationHeightCap(1440)).toBe(1008);
    expect(visualizationHeightCap(800)).toBe(560);
  });

  it('硬顶 1200：超大气泡区不再涨', () => {
    expect(visualizationHeightCap(4000)).toBe(1200);
  });

  it('气泡区不够也给足 320：装不下就整区滚，不把块压没', () => {
    expect(visualizationHeightCap(600)).toBe(420);
    expect(visualizationHeightCap(200)).toBe(320);
    expect(visualizationHeightCap(0)).toBe(320);
  });
});

describe('materialize', () => {
  it('fragment 原文原样进 body', () => {
    const frag = '<div id="x">hi</div>';
    const doc = materialize(frag, { theme: 'dark', vars: VARS });
    expect(doc).toContain('<body>\n<div id="x">hi</div>\n</body>');
  });

  it('CSP meta 存在且含 CDN 白名单', () => {
    const doc = materialize('<div/>', { theme: 'dark', vars: VARS });
    expect(doc).toMatch(/<meta http-equiv="Content-Security-Policy"/);
    expect(doc).toContain('https://cdn.jsdelivr.net');
    expect(doc).toContain("default-src 'none'");
  });

  it('color-scheme 跟随 weave 主题（iframe 里原生滚动条/表单控件不再跟系统走）', () => {
    expect(materialize('<div/>', { theme: 'dark', vars: VARS })).toContain('color-scheme: dark;');
    expect(materialize('<div/>', { theme: 'light', vars: VARS })).toContain('color-scheme: light;');
  });

  it('主题别名解析成实际色值（dark）', () => {
    const doc = materialize('<div/>', { theme: 'dark', vars: VARS });
    expect(doc).toContain('--background: rgb(10 10 10);');
    expect(doc).toContain('--foreground: rgb(250 250 250);');
    expect(doc).toContain('--card: rgb(23 23 23);');
    expect(doc).toContain('--muted: rgb(38 38 38);');
    expect(doc).toContain('--border: rgb(64 64 64);');
  });

  it('主题别名解析成实际色值（light）', () => {
    const doc = materialize('<div/>', { theme: 'light', vars: VARS });
    expect(doc).toContain('--background: rgb(250 250 250);');
    expect(doc).toContain('--foreground: rgb(245 245 245);');
  });

  it('缺令牌时回落 transparent（不产 NaN/undefined）', () => {
    const doc = materialize('<div/>', { theme: 'dark', vars: {} });
    expect(doc).toContain('--background: transparent;');
    expect(doc).not.toContain('undefined');
  });

  it('openai shim 与 resize 桥都在', () => {
    const doc = materialize('<div/>', { theme: 'dark', vars: VARS });
    expect(doc).toContain('window.openai');
    expect(doc).toContain("type: 'viz-resize'");
    expect(doc).toContain("parent.postMessage");
  });
});
