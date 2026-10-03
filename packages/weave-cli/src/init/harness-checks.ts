import { checkHarness as checkHarnessCore, type HarnessCheck as StructuredCheck } from '@weave/core';
import { t } from '../i18n/index.js';
import type { MessageKey } from '../i18n/dict/index.js';

/**
 * Thin CLI adapter over the core structured health checks.
 *
 * Core (`@weave/core`) detects the failures and returns `{ id, params, ok }`
 * with zero text; this layer filters the failures and renders message/fix from
 * the CLI dictionary, so `weave status` keeps its exact output. Surfaced by
 * `weave status`.
 */

export interface HarnessCheck {
  id: string;
  message: string;
  /** What the user should do about it. */
  fix: string;
}

const RENDER: Record<string, { message: MessageKey; fix: MessageKey }> = {
  'instruction-link-not-materialised': {
    message: 'harness.instructionLinkNotMaterialised.message',
    fix: 'harness.instructionLinkNotMaterialised.fix',
  },
  'instruction-files-duplicated': {
    message: 'harness.instructionFilesDuplicated.message',
    fix: 'harness.instructionFilesDuplicated.fix',
  },
  'instruction-link-dangling': {
    message: 'harness.instructionLinkDangling.message',
    fix: 'harness.instructionLinkDangling.fix',
  },
  'statusline-path-unresolved': {
    message: 'harness.statuslinePathUnresolved.message',
    fix: 'harness.statuslinePathUnresolved.fix',
  },
  'statusline-path-foreign': {
    message: 'harness.statuslinePathForeign.message',
    fix: 'harness.statuslinePathForeign.fix',
  },
  'statusline-script-missing': {
    message: 'harness.statuslineScriptMissing.message',
    fix: 'harness.statuslineScriptMissing.fix',
  },
};

/**
 * Run every harness check and render the failures with the CLI dictionary.
 * Returns only the problems found, in reporting order.
 * Never throws — a check that cannot run is simply not reported.
 */
export async function checkHarness(dir: string): Promise<HarnessCheck[]> {
  const checks: StructuredCheck[] = await checkHarnessCore(dir);
  return checks
    .filter((c) => !c.ok)
    .map((c) => ({
      id: c.id,
      message: t(RENDER[c.id].message, c.params),
      fix: t(RENDER[c.id].fix, c.params),
    }));
}
