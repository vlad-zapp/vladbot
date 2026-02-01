import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import type { ModelInfo } from "@vladbot/shared";
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

  // Derive selectedModel from the active session's stored model
  const selectedModel = useMemo(() => {
    if (!activeSession?.model) return models[0] ?? null;
    return models.find((m) => m.id === activeSession.model) ?? models[0] ?? null;
  }, [activeSession?.model, models]);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [currentView, setCurrentView] = useState<View>("chat");
  const [visionModel, setVisionModel] = useState(settings?.vision_model ?? "");

  useEffect(() => {
    if (settings?.vision_model != null) setVisionModel(settings.vision_model);
  }, [settings?.vision_model]);

  const visionOverrideWarning =
    !!selectedModel?.nativeVision && !!visionModel;

  // Auto-reset vision model when the user switches to a model with native vision.
  // Only fires on actual model-to-model switches (not on initial load).
  const prevModelIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = selectedModel?.id;
    const prev = prevModelIdRef.current;
    prevModelIdRef.current = id;
    // Only act when switching from one model to another, not on first load
    if (!prev || !id || prev === id) return;
    if (selectedModel?.nativeVision && visionModel) {
      setVisionModel("");
      saveSettings({ vision_model: "" }).catch(console.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModel?.id]);

  const handleAutoApproveChange = useCallback(
    (value: boolean) => {
      if (!activeSessionId) return;
      setSessionAutoApprove(activeSessionId, value);
    },
    [activeSessionId, setSessionAutoApprove],
  );

  const handleVisionModelChange = useCallback(
    async (value: string) => {
      setVisionModel(value);
      try {
        await saveSettings({ vision_model: value });
      } catch (err) {
        console.error("Failed to save vision model:", err);
      }
    },
    [saveSettings],
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
      // Persist so new sessions use this model
      saveSettings({ default_model: newModel.id }).catch(console.error);
    },
    [activeSessionId, switchModel, saveSettings],
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
