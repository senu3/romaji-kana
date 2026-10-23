import { Plus, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { DocumentVocabularyProfile } from "../lib/documentVocabulary";
import { createId } from "../lib/id";
import type { UserDictionaryEntry } from "../lib/types";
import type { PersonalWord } from "../lib/kanaEngine";
import { PersonalDictionary } from "./PersonalDictionary";

const MAX_USER_DICTIONARY_ENTRIES = 50;

export function DictionaryModal({
  entries,
  documentVocabularyProfile,
  useDocumentVocabulary,
  onUseDocumentVocabularyChange,
  onChange,
  personalWords = [],
  onPersonalWordsChange,
}: {
  entries: UserDictionaryEntry[];
  documentVocabularyProfile: DocumentVocabularyProfile;
  useDocumentVocabulary: boolean;
  onUseDocumentVocabularyChange: (enabled: boolean) => void;
  onChange: (entries: UserDictionaryEntry[]) => void;
  personalWords?: PersonalWord[];
  onPersonalWordsChange?: (words: PersonalWord[]) => void;
}) {
  const [activeTab, setActiveTab] = useState<"registered" | "detected" | "personal">("personal");
  const [draft, setDraft] = useState({ reading: "", output: "", note: "" });
  const [detectedDraft, setDetectedDraft] = useState<{
    reading: string;
    output: string;
    note: string;
  } | null>(null);
  const [detectedStatus, setDetectedStatus] = useState("");
  const detectedReadingInputRef = useRef<HTMLInputElement | null>(null);
  const detectedTerms = documentVocabularyProfile.terms.slice(0, 30);
  const registeredOutputs = new Set(
    entries.map((entry) => entry.output.trim()).filter(Boolean),
  );
  const canAdd =
    draft.reading.trim().length > 0 &&
    draft.output.trim().length > 0 &&
    entries.length < MAX_USER_DICTIONARY_ENTRIES;
  const canAddDetected =
    Boolean(detectedDraft?.reading.trim()) &&
    Boolean(detectedDraft?.output.trim()) &&
    entries.length < MAX_USER_DICTIONARY_ENTRIES;
  const detectedDraftOpen = detectedDraft !== null;

  useEffect(() => {
    if (detectedDraftOpen) {
      detectedReadingInputRef.current?.focus();
    }
  }, [detectedDraftOpen]);

  const appendEntry = (nextDraft: { reading: string; output: string; note: string }) => {
    onChange([
      ...entries,
      {
        id: createDictionaryEntryId(),
        reading: nextDraft.reading.trim(),
        output: nextDraft.output.trim(),
        note: nextDraft.note.trim(),
        enabled: true,
      },
    ]);
  };

  const addEntry = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canAdd) {
      return;
    }

    appendEntry(draft);
    setDraft({ reading: "", output: "", note: "" });
  };

  const selectDetectedTerm = (term: string) => {
    if (registeredOutputs.has(term) || entries.length >= MAX_USER_DICTIONARY_ENTRIES) {
      return;
    }
    setDetectedStatus("");
    setDetectedDraft({
      reading: suggestedRomajiReading(term),
      output: term,
      note: "文書から追加",
    });
  };

  const addDetectedEntry = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detectedDraft || !canAddDetected) {
      return;
    }

    const output = detectedDraft.output.trim();
    appendEntry(detectedDraft);
    setDetectedDraft(null);
    setDetectedStatus(`${output} を辞書に追加しました。`);
  };

  const updateEntry = (id: string, patch: Partial<UserDictionaryEntry>) => {
    onChange(
      entries.map((entry) =>
        entry.id === id
          ? {
            ...entry,
            ...patch,
          }
          : entry,
      ),
    );
  };

  const deleteEntry = (id: string) => {
    onChange(entries.filter((entry) => entry.id !== id));
  };

  return (
    <section className="dictionary-modal inspector-panel" aria-label="辞書項目">
      <div className="dictionary-tabs" role="tablist" aria-label="辞書の表示">
        <button type="button" role="tab" id="dictionary-personal-tab" aria-controls="dictionary-personal-panel"
          aria-selected={activeTab === "personal"} className={activeTab === "personal" ? "selected" : ""}
          onClick={() => setActiveTab("personal")}>個人語彙 {personalWords.length}</button>
        <button
          id="dictionary-registered-tab"
          className={activeTab === "registered" ? "selected" : ""}
          type="button"
          role="tab"
          aria-selected={activeTab === "registered"}
          aria-controls="dictionary-registered-panel"
          onClick={() => setActiveTab("registered")}
        >
          登録済みスニペット {entries.length}
        </button>
        <button
          id="dictionary-detected-tab"
          className={activeTab === "detected" ? "selected" : ""}
          type="button"
          role="tab"
          aria-selected={activeTab === "detected"}
          aria-controls="dictionary-detected-panel"
          onClick={() => setActiveTab("detected")}
        >
          文書から検出 {detectedTerms.length}
        </button>
      </div>

      {activeTab === "personal" && <div id="dictionary-personal-panel" role="tabpanel" aria-labelledby="dictionary-personal-tab">
        <PersonalDictionary words={personalWords} onChange={onPersonalWordsChange ?? (() => undefined)} />
      </div>}

      {activeTab === "registered" ? (
        <div
          id="dictionary-registered-panel"
          role="tabpanel"
          aria-labelledby="dictionary-registered-tab"
        >
          <form className="dictionary-add-form" onSubmit={addEntry}>
            <label className="field">
              <span>Romaji reading</span>
              <input
                aria-label="Romaji reading"
                value={draft.reading}
                maxLength={80}
                placeholder="openai"
                onChange={(event) => {
                  const reading = event.currentTarget.value;
                  setDraft((value) => ({ ...value, reading }));
                }}
              />
            </label>
            <label className="field">
              <span>出力</span>
              <input
                aria-label="出力"
                value={draft.output}
                maxLength={80}
                placeholder="OpenAI"
                onChange={(event) => {
                  const output = event.currentTarget.value;
                  setDraft((value) => ({ ...value, output }));
                }}
              />
            </label>
            <label className="field dictionary-note-field">
              <span>メモ</span>
              <input
                aria-label="メモ"
                value={draft.note}
                maxLength={120}
                placeholder="会社名など"
                onChange={(event) => {
                  const note = event.currentTarget.value;
                  setDraft((value) => ({ ...value, note }));
                }}
              />
            </label>
            <button
              className="primary-button dictionary-add-button"
              type="submit"
              disabled={!canAdd}
            >
              <Plus size={16} aria-hidden="true" />
              追加
            </button>
          </form>

          <div className="dictionary-list-header">
            <strong>{entries.length} / {MAX_USER_DICTIONARY_ENTRIES}</strong>
          </div>
          {entries.length === 0 ? (
            <p className="empty-state">辞書の登録はまだありません。</p>
          ) : (
            <div className="dictionary-list">
              {entries.map((entry, index) => (
                <article className={`dictionary-entry ${entry.enabled ? "" : "disabled"}`} key={entry.id}>
                  <label className="dictionary-enable">
                    <input
                      type="checkbox"
                      checked={entry.enabled}
                      onChange={(event) =>
                        updateEntry(entry.id, { enabled: event.currentTarget.checked })
                      }
                    />
                    有効
                  </label>
                  <div className="dictionary-entry-fields">
                    <input
                      aria-label={`辞書の読み ${index + 1}`}
                      value={entry.reading}
                      maxLength={80}
                      onChange={(event) =>
                        updateEntry(entry.id, { reading: event.currentTarget.value })
                      }
                    />
                    <input
                      aria-label={`辞書の出力 ${index + 1}`}
                      value={entry.output}
                      maxLength={80}
                      onChange={(event) =>
                        updateEntry(entry.id, { output: event.currentTarget.value })
                      }
                    />
                    <input
                      aria-label={`辞書のメモ ${index + 1}`}
                      value={entry.note}
                      maxLength={120}
                      placeholder="メモ"
                      onChange={(event) =>
                        updateEntry(entry.id, { note: event.currentTarget.value })
                      }
                    />
                  </div>
                  <button
                    className="icon-button dictionary-delete"
                    type="button"
                    onClick={() => deleteEntry(entry.id)}
                    aria-label={`${entry.output || entry.reading} を削除`}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </article>
              ))}
            </div>
          )}
        </div>
      ) : activeTab === "detected" ? (
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
              <small>現在の文書で見つけた表記を、同じ読みの候補選びに使います。</small>
            </span>
          </label>

          <div className="document-vocabulary-copy">
            <strong>{detectedTerms.length} 語を検出</strong>
            <p>
              文書語彙はこの文書だけで参照します。よく使う表記は辞書へ追加できます。
            </p>
          </div>

          {detectedTerms.length > 0 ? (
            <div className="document-vocabulary-candidates" aria-label="検出した文書語彙">
              {detectedTerms.map((term) => {
                const registered = registeredOutputs.has(term);
                const selected = detectedDraft?.output === term;
                return (
                  <button
                    className={`${registered ? "registered" : ""} ${selected ? "selected" : ""}`}
                    type="button"
                    key={term}
                    disabled={registered || entries.length >= MAX_USER_DICTIONARY_ENTRIES}
                    onClick={() => selectDetectedTerm(term)}
                    aria-label={registered ? `${term} は登録済み` : `${term} を辞書に追加`}
                  >
                    <span>{term}</span>
                    <small>{registered ? "登録済み" : selected ? "編集中" : "追加"}</small>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="empty-state document-vocabulary-empty">
              漢字・カタカナ・製品名などが文書に増えると、ここに候補が表示されます。
            </p>
          )}

          {detectedDraft ? (
            <form className="detected-vocabulary-form" onSubmit={addDetectedEntry}>
              <div className="detected-vocabulary-form-heading">
                <strong>辞書へ追加</strong>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => setDetectedDraft(null)}
                >
                  キャンセル
                </button>
              </div>
              <label className="field">
                <span>Romaji reading</span>
                <input
                  ref={detectedReadingInputRef}
                  aria-label="検出語彙の Romaji reading"
                  value={detectedDraft.reading}
                  maxLength={80}
                  placeholder="youkenteigi"
                  onChange={(event) => {
                    const reading = event.currentTarget.value;
                    setDetectedDraft((value) =>
                      value ? { ...value, reading } : value,
                    );
                  }}
                />
              </label>
              <label className="field">
                <span>出力</span>
                <input
                  aria-label="検出語彙の出力"
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
                <span>メモ</span>
                <input
                  aria-label="検出語彙のメモ"
                  value={detectedDraft.note}
                  maxLength={120}
                  onChange={(event) => {
                    const note = event.currentTarget.value;
                    setDetectedDraft((value) =>
                      value ? { ...value, note } : value,
                    );
                  }}
                />
              </label>
              <button
                className="primary-button detected-vocabulary-add"
                type="submit"
                disabled={!canAddDetected}
              >
                <Plus size={16} aria-hidden="true" />
                辞書に追加
              </button>
            </form>
          ) : null}

          {entries.length >= MAX_USER_DICTIONARY_ENTRIES ? (
            <p className="dictionary-limit-note">
              辞書が上限の {MAX_USER_DICTIONARY_ENTRIES} 件に達しています。
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

function suggestedRomajiReading(term: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(term) ? term.toLowerCase() : "";
}

function createDictionaryEntryId(prefix = "dictionary"): string {
  return createId(prefix);
}
