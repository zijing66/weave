import type { AssetEntry } from './types.js';

/**
 * In-memory asset cache, keyed by project path then relative path.
 *
 * The watch service is the sole writer; HTTP handlers are read-only consumers.
 * Never persisted to sqlite (filesystem is the single source of truth).
 */
export class WatchCache {
  private readonly byProject = new Map<string, Map<string, AssetEntry>>();

  upsert(projectPath: string, entry: AssetEntry): void {
    let bucket = this.byProject.get(projectPath);
    if (!bucket) {
      bucket = new Map();
      this.byProject.set(projectPath, bucket);
    }
    bucket.set(entry.relPath, entry);
  }

  remove(projectPath: string, relPath: string): void {
    this.byProject.get(projectPath)?.delete(relPath);
  }

  list(projectPath: string): AssetEntry[] {
    const bucket = this.byProject.get(projectPath);
    if (!bucket) return [];
    return [...bucket.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  clear(projectPath: string): void {
    this.byProject.delete(projectPath);
  }

  clearAll(): void {
    this.byProject.clear();
  }
}
