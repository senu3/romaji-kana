import { Check, Plus } from "lucide-react";
import { Fragment, type FormEvent, useEffect, useRef, useState } from "react";
import type { DocumentVocabularyProfile } from "../lib/documentVocabulary";
import { createId } from "../lib/id";
import type { PersonalWord } from "../lib/kanaEngine";
import { PersonalDictionary } from "./PersonalDictionary";
import { normalizePersonalDictionary } from "../lib/settings";
import { ConversionLearningPanel } from "./ConversionLearningPanel";


export function DictionaryModal({
  documentVocabularyProfile,
  useDocumentVocabulary,
  onUseDocumentVocabularyChange,
  personalWords = [],
  onPersonalWordsChange,
}: {
  documentVocabularyProfile: DocumentVocabularyProfile;
  useDocumentVocabulary: boolean;
  onUseDocumentVocabularyChange: (enabled: boolean) => void;
  personalWords?: PersonalWord[];
  onPersonalWordsChange?: (words: PersonalWord[]) => void;
}) {
  const [activeTab, setActiveTab] = useState<"detected" | "personal" | "learning">("personal");
  const [detectedDraft, setDetectedDraft] = useState<{
    term: string;
    reading: string;
    output: string;
    pos: PersonalWord["pos"];
  } | null>(null);
  const [detectedStatus, setDetectedStatus] = useState("");
  const detectedReadingInputRef = useRef<HTMLInputElement | null>(null);
  const detectedTerms = documentVocabularyProfile.terms.slice(0, 30);
  const registeredOutputs = new Set(
    personalWords.filter(word => word.enabled).map(word => word.text),
  );
  const canAddDetected =
    Boolean(detectedDraft?.reading.trim()) &&
    Boolean(detectedDraft?.output.trim()) &&
    personalWords.length < 500 && Boolean(onPersonalWordsChange);
  const selectedTerm = detectedDraft?.term;

  useEffect(() => {
    if (selectedTerm) {
      detectedReadingInputRef.current?.focus();
    }
  }, [selectedTerm]);

  const selectDetectedTerm = (term: string) => {
    if (registeredOutputs.has(term) || !onPersonalWordsChange) {
      return;
    }
    const disabled = personalWords.find(word => word.text === term && !word.enabled);
    if (disabled) {
      onPersonalWordsChange(personalWords.map(word => word.id === disabled.id ? { ...word, enabled: true } : word));
      setDetectedStatus(`${term} の個人語彙を有効にしました。`);
      return;
    }
    if (personalWords.length >= 500) return;
    setDetectedStatus("");
    setDetectedDraft({
      term,
      reading: "",
      output: term,
      pos: "noun",
    });
  };

  const addDetectedEntry = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detectedDraft || !canAddDetected) {
      return;
    }

    const word = normalizePersonalDictionary([{ id: createId("word"), reading: detectedDraft.reading,
      text: detectedDraft.output, pos: detectedDraft.pos, enabled: true }])[0];
    if (!word) { setDetectedStatus("読みはかな、表記は80文字以内で入力してください。"); return; }
    onPersonalWordsChange?.([...personalWords, word]);
    setDetectedDraft(null);
    setDetectedStatus(`${word.text} を個人語彙に追加しました。`);
  };

  const detectedForm = detectedDraft ? (
    <form id="detected-word-form" className="detected-vocabulary-form" onSubmit={addDetectedEntry} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDetectedDraft(null); document.getElementById(`detected-term-${detectedTerms.indexOf(detectedDraft.term)}`)?.focus(); } }}>
      <div className="detected-vocabulary-form-heading">
        <strong>個人語彙へ追加</strong>
        <button
          className="text-button"
          type="button"
          onClick={() => { setDetectedDraft(null); document.getElementById(`detected-term-${detectedTerms.indexOf(detectedDraft.term)}`)?.focus(); }}
        >
          キャンセル
        </button>
      </div>
      <label className="field">
        <span>読み</span>
        <input
          ref={detectedReadingInputRef}
          aria-label="検出語彙のかな読み"
          value={detectedDraft.reading}
          maxLength={80}
          placeholder="ようけんていぎ"
          onChange={(event) => {
            const reading = event.currentTarget.value;
            setDetectedDraft((value) =>
              value ? { ...value, reading } : value,
            );
          }}
        />
      </label>
      <label className="field">
        <span>表記</span>
        <input
          aria-label="検出語彙の表記"
          value={detectedDraft.output}
          maxLength={80}
          onChange={(event) => {
            const output = event.currentTarget.value;
            setDetectedDraft((value) =>
              value ? { ...value, output } : value,
            );
          }}
        />
      </label>
      <label className="field">
        <span>種類</span>
        <select aria-label="検出語彙の種類" value={detectedDraft.pos}
          onChange={event => { const pos = event.currentTarget.value as PersonalWord["pos"]; setDetectedDraft(value => value ? { ...value, pos } : value); }}>
          <option value="noun">一般名詞</option><option value="proper">固有名詞</option>
          <option value="person">人名</option><option value="organization">組織名</option>
        </select>
      </label>
      <button
        className="primary-button detected-vocabulary-add"
        type="submit"
        disabled={!canAddDetected}
      >
        <Plus size={16} aria-hidden="true" />
        個人語彙に追加
      </button>
    </form>
  ) : null;

  return (
    <section className="dictionary-modal inspector-panel" aria-label="辞書項目">
      <div className="dictionary-tabs" role="tablist" aria-label="辞書の表示" onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
        const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next]?.focus(); tabs[next]?.click();
      }}>
        <button type="button" role="tab" id="dictionary-personal-tab" aria-controls="dictionary-personal-panel"
          tabIndex={activeTab === "personal" ? 0 : -1} aria-selected={activeTab === "personal"} className={activeTab === "personal" ? "selected" : ""}
          onClick={() => setActiveTab("personal")}>個人語彙</button>
        <button
          id="dictionary-detected-tab"
          className={activeTab === "detected" ? "selected" : ""}
          type="button"
          role="tab"
          tabIndex={activeTab === "detected" ? 0 : -1} aria-selected={activeTab === "detected"}
          aria-controls="dictionary-detected-panel"
          onClick={() => setActiveTab("detected")}
        >
          文書から検出
        </button>
        <button type="button" role="tab" id="dictionary-learning-tab" aria-controls="dictionary-learning-panel"
          tabIndex={activeTab === "learning" ? 0 : -1} aria-selected={activeTab === "learning"} className={activeTab === "learning" ? "selected" : ""}
          onClick={() => setActiveTab("learning")}>学習履歴</button>
      </div>

      {activeTab === "learning" && <div id="dictionary-learning-panel" role="tabpanel" aria-labelledby="dictionary-learning-tab"><ConversionLearningPanel /></div>}

      {activeTab === "personal" && <div id="dictionary-personal-panel" role="tabpanel" aria-labelledby="dictionary-personal-tab">
        <PersonalDictionary words={personalWords} onChange={onPersonalWordsChange ?? (() => undefined)} />
      </div>}

      {activeTab === "detected" ? (
        <div
          className="document-vocabulary-panel"
          id="dictionary-detected-panel"
          role="tabpanel"
          aria-labelledby="dictionary-detected-tab"
        >
          <label
            className={`document-vocabulary-toggle ${useDocumentVocabulary ? "selected" : ""}`}
          >
            <input
              type="checkbox"
              checked={useDocumentVocabulary}
              onChange={(event) =>
                onUseDocumentVocabularyChange(event.currentTarget.checked)
              }
            />
            <span>
              <strong>文書の語彙に合わせる</strong>
            </span>
          </label>

          {detectedTerms.length > 0 ? (
            <div className="document-vocabulary-candidates" aria-label="検出した文書語彙">
              {detectedTerms.map((term) => {
                const registered = registeredOutputs.has(term);
                const disabled = personalWords.some(word => word.text === term && !word.enabled);
                const selected = selectedTerm === term;
                return (
                  <Fragment key={term}><button
                    id={`detected-term-${detectedTerms.indexOf(term)}`}
                    aria-expanded={selected}
                    aria-controls={selected ? "detected-word-form" : undefined}
                    className={`${registered ? "registered" : ""} ${selected ? "selected" : ""}`}
                    type="button"
                    disabled={registered || !onPersonalWordsChange || (!disabled && personalWords.length >= 500)}
                    onClick={() => selectDetectedTerm(term)}
                    aria-label={registered ? `${term} は個人語彙に登録済み` : disabled ? `${term} の個人語彙を有効にする` : `${term} を個人語彙に追加`}
                  >
                    <span>{term}</span>
                    {registered ? <Check size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
                  </button>{selected ? detectedForm : null}</Fragment>
                );
              })}
            </div>
          ) : (
            <p className="empty-state document-vocabulary-empty">
              漢字・カタカナ・製品名などが文書に増えると、ここに候補が表示されます。
            </p>
          )}

          <details className="dictionary-help"><summary>文書の語彙について</summary>
            <p>現在の文書の表記を、モデル接続時の候補選びに使います。候補にない語は追加されません。</p>
            <p>語を押して読みを登録すると、ほかの文書でも個人語彙として使えます。</p>
          </details>

          {personalWords.length >= 500 ? (
            <p className="dictionary-limit-note">
              個人語彙が上限の500件に達しています。
            </p>
          ) : null}
          <p className="detected-vocabulary-status" role="status" aria-live="polite">
            {detectedStatus}
          </p>
        </div>
      ) : null}
    </section>
  );
}

