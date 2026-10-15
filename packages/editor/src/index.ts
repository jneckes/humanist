// FSL-1.1-ALv2 (packages/editor/LICENSE.md)
//
// The Edit capability (D11, 9.6). The app loads the bundle (dist/editor.cjs) at runtime and codes against
// EditorModule in packages/core/src/capabilities.ts; nothing outside packages/editor imports this package.
// The pure functions are exported too, for the fuzz test and the mutation probe.

import type { EditorModule } from '@blueline/core/capabilities';
import { createWriteQueue } from './write-queue';

/** Kept equal to packages/editor/package.json. */
export const editorVersion = '0.0.0';

export { createWriteQueue };
export type { EditorQueueOptions } from './write-queue';
export { planEdit, findRun } from './plan';
export type { EditPlan, PlanOutcome, PlanRefusal, EditStrategy } from './plan';
export { verifyEdit, verifyUndo, checkParseErrors } from './verify';
export type { VerifyResult, SpliceSpan } from './verify';
export { planUndo, makeRecord, swapRecord, isWriteRecord, CANT_UNDO } from './undo';
export type { UndoPlan, UndoRefusal } from './undo';
export { applySplice } from './splice';

// The bundle must satisfy the capability seam's interface.
const editorModule: EditorModule = { editorVersion, createWriteQueue };
void editorModule;
