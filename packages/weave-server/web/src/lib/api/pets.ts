/** 宠物域：桌面宠物资产列举与 spritesheet 地址（只读面）。 */

import { apiFetch } from './client';

/** mirror of `GET /pets` 行（daemon/routes/pets.ts）。 */
export interface PetRow {
  id: string;
  displayName: string;
  description: string;
  spriteVersionNumber: number;
  /** pet.json 的 mtime（ms）：spritesheet URL 的缓存版本参数。 */
  updatedAt: number;
}

export const petApi = {
  /** 列举 `<data>/pets/` 下的宠物资产（损坏条目服务端跳过）。 */
  listPets: (): Promise<PetRow[]> => apiFetch<{ pets: PetRow[] }>('/pets').then((r) => r.pets),
  /** spritesheet 地址（`?v=` 按 manifest mtime 版本化，内容换了缓存才换）。 */
  spritesheetUrl: (id: string, updatedAt: number): string =>
    `/pets/${encodeURIComponent(id)}/spritesheet?v=${updatedAt}`,
};
