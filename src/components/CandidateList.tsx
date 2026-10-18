import { useEffect, useRef } from "react";
import type { ConversionSession } from "../lib/conversionSession";

export function CandidateList({ session, onSelect, onSpeculate, onClose }: {
  session: ConversionSession;
  onSelect: (id: string) => void;
  onSpeculate: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  const choose = (action: () => void) => {
    // Release modal focus before the editor displays the chosen preview.
    dialogRef.current!.close();
    action();
  };

  return (
    <dialog ref={dialogRef} className="candidate-list-dialog" aria-labelledby="candidate-list-title"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="candidate-list-content">
        <header>
          <h2 id="candidate-list-title">ほかの候補</h2>
          <button type="button" className="history-action-button" onClick={onClose}>閉じる</button>
        </header>
        <p>同じ読みの候補です。選ぶと本文の位置に表示し、Tabで採用できます。</p>
        <ul className="candidate-list-options" aria-label="同じ読みの候補">
          {session.candidates.map(candidate => (
            <li key={candidate.id}>
              <button type="button" aria-pressed={candidate.id === session.selectedId} onClick={() => choose(() => onSelect(candidate.id))}>
                <span>{candidate.result.text}</span>
                {candidate.id === session.selectedId ? <small>現在の候補</small> : null}
              </button>
            </li>
          ))}
        </ul>
        {session.candidates.length < 2 ? <p>ほかの表記はありません。</p> : null}
        <footer>
          <button type="button" className="history-action-button" onClick={() => choose(onSpeculate)}>読みも含めて見直す</button>
          <p>意図に合う候補がないときに、元の入力と文脈から推測します。結果は採用するまで本文に入りません。</p>
        </footer>
      </section>
    </dialog>
  );
}
