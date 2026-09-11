import { Link2, Loader2, Smartphone } from "lucide-react";
import { type FormEvent, useState } from "react";
import { clearRemoteCompanionToken, pairRemoteCompanion } from "../lib/companion";

export function RemotePairingScreen({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError("PCに表示されている6桁の接続コードを入力してください。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await pairRemoteCompanion(code);
      onPaired();
    } catch (pairingError: unknown) {
      clearRemoteCompanionToken();
      setError(pairingError instanceof Error ? pairingError.message : String(pairingError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="pairing-page">
      <section className="pairing-sheet" aria-labelledby="pairing-title">
        <div className="pairing-brand" aria-hidden="true">
          <span className="app-logo">か</span>
          <span>Romaji Kana</span>
        </div>
        <div className="pairing-device-mark" aria-hidden="true">
          <Smartphone size={34} />
          <Link2 size={22} />
        </div>
        <h1 id="pairing-title">PCとつなぐ</h1>
        <p>PC版の「スマホ連携」に表示されている接続コードを入力してください。</p>
        <form onSubmit={submit} className="pairing-form">
          <label htmlFor="pairing-code">6桁の接続コード</label>
          <input
            id="pairing-code"
            value={code}
            onChange={(event) => setCode(event.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            maxLength={6}
            autoFocus
          />
          {error ? <p className="pairing-error" role="alert">{error}</p> : null}
          <button className="primary-button pairing-submit" type="submit" disabled={busy || code.length !== 6}>
            {busy ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <Link2 size={18} aria-hidden="true" />}
            {busy ? "接続しています..." : "PCに接続"}
          </button>
        </form>
        <small>文章と変換要求は同じWi-Fi内のPCとの間だけで送受信されます。</small>
      </section>
    </main>
  );
}
