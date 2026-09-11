import { AlertCircle } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { clearRemoteCompanionToken, isRemoteCompanionClient } from "../lib/companion";

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Romaji Kana stopped unexpectedly.", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) {
      return this.props.children;
    }

    const remoteMode = isRemoteCompanionClient();
    const reconnect = () => {
      clearRemoteCompanionToken();
      window.location.reload();
    };

    return (
      <main className="app-error-page">
        <section className="app-error-sheet" role="alert" aria-labelledby="app-error-title">
          <span className="app-error-mark" aria-hidden="true">
            <AlertCircle size={28} />
          </span>
          <h1 id="app-error-title">画面を読み込めませんでした</h1>
          <p>
            {remoteMode
              ? "スマホ連携を読み込み直してください。直らない場合は、PCに表示された接続コードでもう一度つなぎます。"
              : "アプリを読み込み直してください。編集中の下書きは自動退避されています。"}
          </p>
          <div className="app-error-actions">
            <button className="primary-button" type="button" onClick={() => window.location.reload()}>
              読み込み直す
            </button>
            {remoteMode ? (
              <button className="secondary-button" type="button" onClick={reconnect}>
                もう一度つなぐ
              </button>
            ) : null}
          </div>
        </section>
      </main>
    );
  }
}
