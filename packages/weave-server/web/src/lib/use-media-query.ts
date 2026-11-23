import { useEffect, useState } from 'react';

/** 响应式断点 / 指针能力查询（SSR 无 window 时返回 false）。 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** 触屏指针（coarse）查询（归口：matchMedia 裸调不得散写组件里）。 */
export const COARSE_QUERY = '(hover: none), (pointer: coarse)';

export function useIsCoarsePointer(): boolean {
  return useMediaQuery(COARSE_QUERY);
}
