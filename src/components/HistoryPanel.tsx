import { Loader2, RotateCcw, X } from "lucide-react";
import type { ConversionHistoryItem, InputCompletionLevel, PendingConversion } from "../lib/types";

export function RecentRetryChip({
  item,
  onRetry,
  onDismiss,
}: {
  item: ConversionHistoryItem;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <aside
      className={`recent-retry-chip ${item.conversionStrategy === "completion" ||
          item.conversionStrategy === "speculative" ||
          item.inputCompletionApplied
          ? "completion"
          : ""
        }`}
      aria-label="別候補への再変換"
    >
      <button
        className="recent-retry-chip-main"
        type="button"
        onClick={onRetry}
        title="別候補を再生成"
      >
        <RotateCcw size={15} aria-hidden="true" />
        <span className="recent-retry-chip-text">
          {item.conversionStrategy === "speculative"
            ? item.output
              ? `推測候補: ${item.output}`
              : "推測候補を確定しました"
            : item.inputCompletionApplied
              ? item.output
                ? `入力補完: ${item.output}`
                : "入力補完で生成しました"
              : item.conversionStrategy === "completion"
                ? item.output
                  ? `補完変換: ${item.output}`
                  : "補完変換で生成しました"
                : item.output
                  ? `${item.output} の別候補を試す`
                  : "別候補を試す"}
        </span>
        <kbd>Ctrl/Cmd+/</kbd>
      </button>
      <button
        className="recent-retry-chip-dismiss"
        type="button"
        onClick={onDismiss}
        aria-label="別候補チップを閉じる"
        title="閉じる"
      >
        <X size={15} aria-hidden="true" />
      </button>
    </aside>
  );
}

export function HistoryPanel({
  history,
  pending,
  onCancel,
  onRerun,
  onAlternative,
  onPreview,
  onPreviewEnd,
  onClose,
}: {
  history: ConversionHistoryItem[];
  pending: PendingConversion[];
  onCancel: (request: PendingConversion) => void;
  onRerun: (item: ConversionHistoryItem) => void;
  onAlternative: (item: ConversionHistoryItem) => void;
  onPreview: (item: ConversionHistoryItem) => void;
  onPreviewEnd: (item: ConversionHistoryItem) => void;
  onClose: () => void;
}) {
  return (
    <section className="floating-panel history-panel" aria-label="変換履歴">
      {pending.length > 0 ? (
        <div className="pending-list" aria-label="処理中の変換">
          {pending.map((request) => (
            <article className="pending-item" key={request.id}>
              <div className="pending-copy">
                <span className="pending-state">
                  <Loader2 size={13} className="spin" aria-hidden="true" />
                  {request.retryOf
                    ? request.status === "queued"
                      ? "再試行待ち"
                      : "別候補を生成中"
                    : request.status === "queued"
                      ? "待機中"
                      : request.source === "history"
                        ? "再適用中"
                        : "変換中"}
                </span>
                <p>{request.originalText}</p>
              </div>
              <button className="history-action-button" type="button" onClick={() => onCancel(request)}>
                キャンセル
              </button>
            </article>
          ))}
        </div>
      ) : null}

      {history.length === 0 ? (
        <p className="empty-state">
          この起動中に確定・適用した変換が最大100件残ります。選択範囲またはカーソルのある行は Ctrl/Cmd + Enter で変換できます。
        </p>
      ) : (
        <div className="history-list" role="list">
          {history.map((item) => (
            <article
              className={`history-item ${item.status}`}
              key={item.id}
              role="listitem"
              onBlur={() => onPreviewEnd(item)}
              onFocus={() => onPreview(item)}
              onMouseEnter={() => onPreview(item)}
              onMouseLeave={() => onPreviewEnd(item)}
            >
              <div className="history-meta">
                <span className="history-status">
                  <span className={`history-status-dot ${item.status}`} aria-hidden="true" />
                  {historyStatusLabel(item.status)}
                </span>
                {item.documentVocabulary?.length ? (
                  <span
                    className="history-vocabulary-badge"
                    title="この変換で参照した文書語彙"
                  >
                    文書語彙 {item.documentVocabulary.length}
                  </span>
                ) : null}
                <time dateTime={new Date(item.createdAt).toISOString()}>
                  {new Date(item.createdAt).toLocaleTimeString()}
                </time>
              </div>
              <dl className="history-lines">
                <div className="history-line">
                  <dt>入力</dt>
                  <dd>{item.input}</dd>
                </div>
                <div className="history-line">
                  <dt>{item.status === "success" ? "出力" : "結果"}</dt>
                  <dd>{item.output ?? item.error ?? "出力はありません。"}</dd>
                </div>
              </dl>
              <div className="rerun-meta">
                <span className="history-model">{item.modelName}</span>
                <span
                  className={`history-completion-level ${item.inputCompletionApplied ? "applied" : ""
                    }`}
                  title={
                    item.inputCompletionApplied && item.inputCompletionSourceKana
                      ? `補完前: ${item.inputCompletionSourceKana}`
                      : "この変換で使用した入力補完レベル"
                  }
                >
                  {historyInputCompletionLabel(
                    item.inputCompletionLevel,
                    item.inputCompletionApplied,
                  )}
                </span>
                <button
                  className="history-action-button"
                  type="button"
                  title="同じ入力をもう一度変換します"
                  onFocus={() => onPreview(item)}
                  onClick={() => {
                    onPreviewEnd(item);
                    onRerun(item);
                    onClose();
                  }}
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  再試行
                </button>
                <button
                  className="history-action-button"
                  type="button"
                  disabled={!item.output}
                  title={item.output ? "前回結果を避けて別候補を生成します" : "出力がないため別候補は生成できません"}
                  onFocus={() => onPreview(item)}
                  onClick={() => {
                    onPreviewEnd(item);
                    onAlternative(item);
                    onClose();
                  }}
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  別候補
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function historyStatusLabel(status: ConversionHistoryItem["status"]): string {
  if (status === "success") {
    return "成功";
  }
  if (status === "error") {
    return "失敗";
  }
  if (status === "skipped") {
    return "スキップ";
  }
  return "キャンセル";
}

function historyInputCompletionLabel(
  level: InputCompletionLevel | undefined,
  applied: boolean | undefined,
): string {
  if (level === "word") {
    return applied ? "単語補完・適用" : "単語補完・変更なし";
  }
  if (level === "sentence") {
    return applied ? "文章補完・適用" : "文章補完・変更なし";
  }
  return "入力どおり";
}
