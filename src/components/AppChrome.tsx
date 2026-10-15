import {
  AlertCircle,
  BookMarked,
  CheckCircle2,
  History,
  Loader2,
  MessageSquareText,
  SlidersHorizontal,
  Smartphone,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { ThemeSelect } from "./ThemeSelect";
import type { ActivePanel } from "../lib/appTypes";
import { providerLabel } from "../lib/ollama";
import type {
  AppSettings,
  ConversionStatus,
  OllamaConnectionStatus,
  PendingConversion,
} from "../lib/types";
import type { EditorDocumentStatus } from "./MarkdownEditor";

export function AppTitleBar() {
  return (
    <header className="app-titlebar" aria-label="アプリケーションヘッダー">
      <div className="app-brand">
        <span className="app-logo" aria-hidden="true">か</span>
        <span>Romaji Kana</span>
      </div>
      <ThemeSelect />
    </header>
  );
}

export function AppRail({
  historyCount,
  dictionaryCount,
  activePanel,
  modelAttention,
  remoteMode,
  companionRunning,
  onOpenHistory,
  onOpenConversion,
  onOpenDictionary,
  onOpenModel,
  onOpenCompanion,
}: {
  historyCount: number;
  dictionaryCount: number;
  activePanel: ActivePanel;
  modelAttention: boolean;
  remoteMode: boolean;
  companionRunning: boolean;
  onOpenHistory: () => void;
  onOpenConversion: () => void;
  onOpenDictionary: () => void;
  onOpenModel: () => void;
  onOpenCompanion: () => void;
}) {
  return (
    <nav className="app-rail" aria-label="アプリのツール">
      {!remoteMode ? (
        <button
          className={`rail-button ${activePanel === "model" ? "active" : ""} ${modelAttention ? "attention" : ""}`}
          type="button"
          onClick={onOpenModel}
          aria-pressed={activePanel === "model"}
          aria-label="モデルを開く"
          title="モデル"
        >
          <SlidersHorizontal size={18} aria-hidden="true" />
          <span>モデル</span>
        </button>
      ) : null}
      <button
        className={`rail-button ${activePanel === "history" ? "active" : ""}`}
        type="button"
        onClick={onOpenHistory}
        aria-pressed={activePanel === "history"}
        aria-label={`履歴を開く、${historyCount} 件`}
        title="履歴"
      >
        <History size={18} aria-hidden="true" />
        {historyCount > 0 ? <span className="rail-count">{historyCount}</span> : null}
        <span>履歴</span>
      </button>
      <button
        className={`rail-button ${activePanel === "conversion" ? "active" : ""}`}
        type="button"
        onClick={onOpenConversion}
        aria-pressed={activePanel === "conversion"}
        aria-label="変換を開く"
        title="変換"
      >
        <MessageSquareText size={18} aria-hidden="true" />
        <span>変換</span>
      </button>
      <button
        className={`rail-button ${activePanel === "dictionary" ? "active" : ""}`}
        type="button"
        onClick={onOpenDictionary}
        aria-pressed={activePanel === "dictionary"}
        aria-label={
          dictionaryCount > 0
            ? `辞書を開く、${dictionaryCount} 件有効`
            : "辞書を開く"
        }
        title="辞書"
      >
        <BookMarked size={18} aria-hidden="true" />
        {dictionaryCount > 0 ? <span className="rail-count">{dictionaryCount}</span> : null}
        <span>辞書</span>
      </button>
      {!remoteMode ? (
        <button
          className={`rail-button ${activePanel === "companion" ? "active" : ""} ${companionRunning ? "connected" : ""}`}
          type="button"
          onClick={onOpenCompanion}
          aria-pressed={activePanel === "companion"}
          aria-label={companionRunning ? "スマホ連携を開く、連携中" : "スマホ連携を開く"}
          title="スマホ連携"
        >
          <Smartphone size={18} aria-hidden="true" />
          {companionRunning ? <span className="connection-dot" aria-hidden="true" /> : null}
          <span>スマホ</span>
        </button>
      ) : null}
    </nav>
  );
}

export function formatModelStatusLabel(
  settings: AppSettings,
  ollamaConnection: OllamaConnectionStatus,
): string {
  const label = providerLabel(settings);
  const modelName = settings.modelName.trim() || "モデル未選択";

  if (ollamaConnection.kind === "connected") {
    return `${label} · ${modelName} · 接続済み`;
  }
  if (ollamaConnection.kind === "checking") {
    return `${label} · ${modelName} · 確認中`;
  }
  if (ollamaConnection.kind === "error") {
    return `${label} · ${modelName} · 未接続`;
  }
  if (ollamaConnection.kind === "warning") {
    return `${label} · ${modelName} · 要確認`;
  }
  return `${label} · ${modelName} · 未確認`;
}

export function InspectorDrawer({
  panel,
  children,
  onClose,
}: {
  panel: NonNullable<ActivePanel>;
  children: ReactNode;
  onClose: () => void;
}) {
  const title = panelTitle(panel);
  const eyebrow = panelEyebrow(panel);

  return (
    <div className="inspector-overlay" onMouseDown={onClose}>
      <aside
        className="inspector-drawer"
        role="dialog"
        aria-labelledby="inspector-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="inspector-header">
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2 id="inspector-title">{title}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label={`${title} を閉じる`}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="inspector-body">{children}</div>
      </aside>
    </div>
  );
}

function panelTitle(panel: NonNullable<ActivePanel>): string {
  if (panel === "model") {
    return "モデル";
  }
  if (panel === "history") {
    return "履歴";
  }
  if (panel === "dictionary") {
    return "辞書";
  }
  if (panel === "companion") {
    return "スマホ連携";
  }
  return "変換";
}

function panelEyebrow(panel: NonNullable<ActivePanel>): string {
  if (panel === "model") {
    return "ローカルAI";
  }
  if (panel === "history") {
    return "変換履歴";
  }
  if (panel === "dictionary") {
    return "ユーザー辞書";
  }
  if (panel === "companion") {
    return "同じWi-Fiで接続";
  }
  return "入力と変換";
}

export function StatusBar({
  status,
  pending,
  pendingCount,
  editorStatus,
  onCancel,
  onOpenModel,
}: {
  status: ConversionStatus;
  pending: PendingConversion[];
  pendingCount: number;
  editorStatus: EditorDocumentStatus;
  onCancel: (request: PendingConversion) => void;
  onOpenModel: () => void;
}) {
  const Icon =
    status.kind === "loading" ? Loader2 : status.kind === "error" ? AlertCircle : CheckCircle2;
  const canOpenSettings = status.kind === "warning" || status.kind === "error";
  const hasStatusActions = canOpenSettings || Boolean(pending[0]) || pendingCount > 0;

  return (
    <div className={`status-bar ${status.kind} ${hasStatusActions ? "has-actions" : ""}`}>
      <div className="status-main" role="status" aria-live="polite">
        <Icon size={16} className={status.kind === "loading" ? "spin" : ""} aria-hidden="true" />
        <span className="status-message">{status.message}</span>
      </div>
      <div className="status-side">
        {hasStatusActions ? (
          <div className="status-actions">
            {canOpenSettings ? (
              <button className="status-settings" type="button" onClick={onOpenModel}>
                モデルを開く
              </button>
            ) : null}
            {pending[0] ? (
              <button className="status-cancel" type="button" onClick={() => onCancel(pending[0])}>
                遅い変換をキャンセル
              </button>
            ) : null}
            {pendingCount > 0 ? <strong>{pendingCount} 件待機中</strong> : null}
          </div>
        ) : null}
        <div className="status-meta" aria-label="文書情報">
          <span>行 {editorStatus.line}, 列 {editorStatus.column}</span>
          <span>
            {editorStatus.selectionCount > 0
              ? `${editorStatus.selectionCount} 文字選択`
              : `${editorStatus.characterCount} 文字`}
          </span>
          <span>UTF-8</span>
          <span>Markdown</span>
        </div>
      </div>
    </div>
  );
}
