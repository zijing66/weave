import { useEffect, useState } from 'react';

/**
 * GitHub 仓库链接与 star 数。
 *
 * star 走**浏览器直取** GitHub 公开 API（不在 daemon 加代理路由）：未登录限流
 * 60 次/时/IP，故 localStorage 缓存 6 小时——正常使用一天也就几次。
 * **取不到就只显示图标**：外网不可达是常态，不报错、不 toast、不占位。
 */

export const WEAVE_REPO = 'zijing66/weave';
export const WEAVE_REPO_URL = `https://github.com/${WEAVE_REPO}`;

const CACHE_KEY = 'weave.github.stars';
const TTL_MS = 6 * 60 * 60 * 1000;

/** 1234 → 1.2k（纯视觉压缩；<1000 原样）。 */
export function formatStars(count: number): string {
  if (count < 1000) return String(count);
  const k = count / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
}

function readCache(): number | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { count?: unknown; at?: unknown };
    if (typeof parsed.count !== 'number' || typeof parsed.at !== 'number') return null;
    if (Date.now() - parsed.at > TTL_MS) return null;
    return parsed.count;
  } catch {
    return null;
  }
}

function writeCache(count: number): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ count, at: Date.now() }));
  } catch {
    // 隐私模式/配额满：缓存失败无所谓，下次再取
  }
}

/** 仓库 star 数；未知（未取到/离线/限流）→ null。 */
export function useRepoStars(): number | null {
  const [stars, setStars] = useState<number | null>(() => readCache());

  useEffect(() => {
    if (readCache() !== null) return; // 缓存新鲜，不打扰网络
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`https://api.github.com/repos/${WEAVE_REPO}`, {
          headers: { accept: 'application/vnd.github+json' },
        });
        if (!res.ok) return;
        const body = (await res.json()) as { stargazers_count?: unknown };
        if (cancelled || typeof body.stargazers_count !== 'number') return;
        writeCache(body.stargazers_count);
        setStars(body.stargazers_count);
      } catch {
        // 离线/被墙/限流：保持 null（界面只显示图标）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return stars;
}
