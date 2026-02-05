export {
  getLLMContext,
  buildHistoryFromDB,
  performCompaction,
  autoCompactIfNeeded,
  computeDisplayType,
  computeToolStatuses,
  enrichMessageForDisplay,
  type CompactionResult,
} from "./ContextManager.js";

export {
  createSnapshot,
  getActiveSnapshot,
  getSnapshotById,
  getMessagesByIds,
  setActiveSnapshot,
  updateSessionTokenCount,
  getSessionTokenCount,
  incrementSessionTokenCount,
  getMessagesAfterTimestamp,
  getSessionSnapshots,
  type ContextSnapshot,
  type CreateSnapshotParams,
} from "./SnapshotStore.js";
