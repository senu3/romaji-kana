import { CheckCircle2, Loader2, Wifi, WifiOff } from "lucide-react";
import { useState } from "react";
import type { CompanionStatus } from "../lib/companion";

export function CompanionPanel({
  status,
  busy,
  onStart,
  onStop,
}: {
  status: CompanionStatus;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      window.setTimeout(() => setCopiedUrl((current) => current === url ? null : current), 1_800);
    } catch {
      setCopiedUrl(null);
    }
  };

  return (
    <div className="companion-panel">
      <div className={`companion-state ${status.running ? "running" : "stopped"}`}>
        <span className="companion-state-icon" aria-hidden="true">
          {status.running ? <Wifi size={22} /> : <WifiOff size={22} />}
        </span>
        <div>
          <strong>{status.running ? "スマホから接続できます" : "スマホ連携は停止中です"}</strong>
          <p>
            {status.running
              ? `ペアリング済み ${status.pairedClients} 回。PCが文書と変換処理を担当します。`
              : "必要なときだけ開始できます。モデルAPIを直接ネットワークへ公開しません。"}
          </p>
        </div>
      </div>

      {status.running ? (
        <>
          <section className="companion-section" aria-labelledby="companion-url-title">
            <h3 id="companion-url-title">スマホで開くURL</h3>
            {status.urls.length > 0 ? (
              <div className="companion-url-list">
                {status.urls.map((url) => (
                  <div className="companion-url" key={url}>
                    <input value={url} readOnly aria-label="スマホ接続URL" />
                    <button className="secondary-button" type="button" onClick={() => void copyUrl(url)}>
                      {copiedUrl === url ? <CheckCircle2 size={16} aria-hidden="true" /> : null}
                      {copiedUrl === url ? "コピー済み" : "コピー"}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="companion-note">LAN内のIPアドレスを取得できませんでした。Wi-Fi接続を確認してください。</p>
            )}
          </section>

          <section className="companion-code" aria-labelledby="companion-code-title">
            <div>
              <h3 id="companion-code-title">接続コード</h3>
              <p>スマホの接続画面に入力します。</p>
            </div>
            <output aria-label="6桁の接続コード">{status.pairCode ?? "------"}</output>
          </section>

          <ol className="companion-steps">
            <li>PCとスマホを同じWi-Fiへ接続</li>
            <li>スマホで上のURLを開く</li>
            <li>6桁の接続コードを入力</li>
          </ol>
        </>
      ) : null}

      <button
        className={status.running ? "secondary-button companion-toggle" : "primary-button companion-toggle"}
        type="button"
        disabled={busy}
        onClick={status.running ? onStop : onStart}
      >
        {busy ? <Loader2 className="spin" size={18} aria-hidden="true" /> : status.running ? <WifiOff size={18} aria-hidden="true" /> : <Wifi size={18} aria-hidden="true" />}
        {busy ? "処理しています..." : status.running ? "スマホ連携を停止" : "スマホ連携を開始"}
      </button>
      <p className="companion-security-note">公共Wi-Fiでは使用せず、利用後は連携を停止してください。</p>
    </div>
  );
}
