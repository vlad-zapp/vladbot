import { useState, useCallback, useMemo } from "react";
import type { ModelInfo } from "@vladbot/shared";
import { findModel } from "@vladbot/shared";
import Header from "./components/Layout/Header.js";
import type { View } from "./components/Layout/Header.js";
import Sidebar from "./components/Sidebar/Sidebar.js";
import ChatContainer from "./components/Chat/ChatContainer.js";
import MemoryManager from "./components/Memory/MemoryManager.js";
import ToolTester from "./components/Tools/ToolTester.js";
import SettingsPage from "./components/Settings/SettingsPage.js";
import ConnectionOverlay from "./components/Layout/ConnectionOverlay.js";
import { useModels } from "./hooks/useModels.js";
import { useChat } from "./hooks/useChat.js";
import { useTools } from "./hooks/useTools.js";
import { useSessions } from "./hooks/useSessions.js";
import { useSettings } from "./hooks/useSettings.js";
import { updateSessionVisionModelApi } from "./services/api.js";
import type { DebugEntry } from "./services/api.js";

export default function App() {
  const { settings, saveSettings } = useSettings();
  const { models, loading: modelsLoading } = useModels();
  const { toolDefinitions } = useTools();
  const {
    sessions,
    activeSessionId,
    activeSession,
    loading: sessionsLoading,
    createNewSession,
    deleteSessionById,
    selectSession,
    updateLocalSessionTitle,
    setSessionAutoApprove,
  } = useSessions();

  // Derive selectedModel from the active session's stored model ("provider:modelId" format)
  const selectedModel = useMemo(() => {
    if (!activeSession?.model) return models[0] ?? null;
    return findModel(activeSession.model) ?? models[0] ?? null;
  }, [activeSession?.model, models]);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [currentView, setCurrentView] = useState<View>("chat");

  // Vision model is per-session, derived from the active session
  const visionModel = activeSession?.visionModel ?? "";

  const visionOverrideWarning =
    !!selectedModel?.nativeVision && !!visionModel;

  const handleAutoApproveChange = useCallback(
    (value: boolean) => {
      if (!activeSessionId) return;
      setSessionAutoApprove(activeSessionId, value);
    },
    [activeSessionId, setSessionAutoApprove],
  );

  const handleVisionModelChange = useCallback(
    async (value: string) => {
      if (!activeSessionId) return;
      try {
        await updateSessionVisionModelApi(activeSessionId, value);
      } catch (err) {
        console.error("Failed to save vision model:", err);
      }
    },
    [activeSessionId],
  );

  const handleNewChat = useCallback(async () => {
    await createNewSession();
    setSidebarOpen(false);
  }, [createNewSession]);

  const verbatimBudget = parseInt(
    settings?.compaction_verbatim_budget ?? "40",
    10,
  );

  const {
    messages,
    debugLog,
    isStreaming,
    isCompacting,
    isLoadingSession,
    tokenUsage,
    autoApprove,
    setAutoApprove,
    sendMessage,
    approveToolCalls,
    denyToolCalls,
    compactContext,
    compactionError,
    switchModel,
    hasMore,
    isLoadingOlder,
    loadOlderMessages,
    trimToLatestPage,
    cancelStream,
  } = useChat(
    activeSessionId,
    createNewSession,
    updateLocalSessionTitle,
    activeSession?.autoApprove ?? false,
    handleAutoApproveChange,
  );

  const handleSelectModel = useCallback(
    async (newModel: ModelInfo) => {
      if (!activeSessionId) return;
      await switchModel(newModel.id);
    },
    [activeSessionId, switchModel],
  );

  const debugByMessage = useMemo(() => {
    const map: Record<string, DebugEntry[]> = {};
    for (const entry of debugLog) {
      if (entry.messageId) {
        (map[entry.messageId] ??= []).push(entry);
      }
    }
    return map;
  }, [debugLog]);

  if (modelsLoading || sessionsLoading) {
    return <div className="app-loading">Loading...</div>;
  }

  return (
    <div className="app-layout">
      <ConnectionOverlay />
      <div className="app-main">
        <Header
          models={models}
          selectedModel={selectedModel}
          onSelectModel={handleSelectModel}
          disabled={isStreaming || isCompacting}
          onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
          currentView={currentView}
          onChangeView={setCurrentView}
          visionModel={visionModel}
          onVisionModelChange={handleVisionModelChange}
          visionOverrideWarning={visionOverrideWarning}
        />
        <div className="app-body">
          {currentView === "chat" && (
            <Sidebar
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelectSession={selectSession}
              onNewChat={handleNewChat}
              onDeleteSession={deleteSessionById}
              isOpen={sidebarOpen}
              onClose={() => setSidebarOpen(false)}
            />
          )}
          {currentView === "chat" && (
            <ChatContainer
              messages={messages}
              debugByMessage={debugByMessage}
              isStreaming={isStreaming}
              isLoadingSession={isLoadingSession}
              onSend={sendMessage}
              onCancel={cancelStream}
              onApproveToolCalls={approveToolCalls}
              onDenyToolCalls={denyToolCalls}
              tokenUsage={tokenUsage}
              contextWindow={selectedModel?.contextWindow ?? 0}
              onCompact={compactContext}
              isCompacting={isCompacting}
              compactionError={compactionError}
              verbatimBudget={verbatimBudget}
              autoApprove={autoApprove}
              onToggleAutoApprove={() => setAutoApprove((prev) => !prev)}
              hasMore={hasMore}
              isLoadingOlder={isLoadingOlder}
              onLoadMore={loadOlderMessages}
              onTrimOlder={trimToLatestPage}
            />
          )}
          {currentView === "memories" && <MemoryManager />}
          {currentView === "tools" && <ToolTester tools={toolDefinitions} />}
          {currentView === "settings" && (
            <SettingsPage
              settings={settings}
              models={models}
              onSave={saveSettings}
            />
          )}
        </div>
      </div>
    </div>
  );
}
