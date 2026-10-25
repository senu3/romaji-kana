import { Plus, Trash2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import type { PersonalWord } from "../lib/kanaEngine";
import { normalizePersonalDictionary } from "../lib/settings";
import { createId } from "../lib/id";

export function PersonalDictionary({ words, onChange }: { words: PersonalWord[]; onChange: (words: PersonalWord[]) => void }) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const closeForm = () => { setAdding(false); setReading(""); setText(""); setError(""); addButtonRef.current?.focus(); };
  const [reading, setReading] = useState("");
  const [text, setText] = useState("");
  const [pos, setPos] = useState<PersonalWord["pos"]>("noun");
  const [error, setError] = useState("");
  const add = (event: FormEvent) => {
    event.preventDefault();
    const entry = normalizePersonalDictionary([{ id: createId("word"), reading, text, pos, enabled: true }])[0];
    if (!entry) { setError("読みはかな、表記は80文字以内で入力してください。"); return; }
    if (words.some(w => w.reading === entry.reading && w.text === entry.text && w.pos === entry.pos)) {
      setError("同じ語が登録されています。"); return;
    }
    onChange([...words, entry]);
    setQuery(""); closeForm();
  };
  const kinds = { noun: "一般名詞", proper: "固有名詞", person: "人名", organization: "組織名" };
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ja").replace(/[ァ-ヶ]/g, char => String.fromCharCode(char.charCodeAt(0) - 0x60));
  const visibleWords = words.filter(word => [word.reading, word.text].some(value => normalize(value).includes(normalize(query.trim()))));
  return <div className="personal-dictionary-content">
    <div className="personal-dictionary-toolbar">
      <input type="search" aria-label="個人語彙を検索" placeholder="読み・表記で検索" value={query} onChange={event => setQuery(event.currentTarget.value)} />
      <button ref={addButtonRef} className="primary-button" type="button" disabled={words.length >= 500} aria-expanded={adding} aria-controls={adding ? "personal-word-form" : undefined}
        onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" />登録</button>
    </div>
    {adding && <form id="personal-word-form" className="personal-word-form" onSubmit={add} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeForm(); }
    }}>
      <label className="field"><span>読み</span><input autoFocus aria-label="個人語彙のかな読み" value={reading} maxLength={80}
        placeholder="てすとしゃ" onChange={event => { setReading(event.currentTarget.value); setError(""); }} /></label>
      <label className="field"><span>表記</span><input aria-label="個人語彙の表記" value={text} maxLength={80}
        placeholder="試験社" onChange={event => { setText(event.currentTarget.value); setError(""); }} /></label>
      <label className="field"><span>種類</span><select aria-label="個人語彙の種類" value={pos} onChange={event => setPos(event.currentTarget.value as PersonalWord["pos"])}>
        {Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <div className="personal-word-actions">
        <button className="text-button" type="button" onClick={closeForm}>キャンセル</button>
        <button className="primary-button" type="submit" disabled={!reading.trim() || !text.trim() || words.length >= 500}>語彙を追加</button>
      </div>
      {error && <p className="dictionary-form-error" role="alert">{error}</p>}
    </form>}
    {words.length >= 500 && <p className="dictionary-limit-note">登録上限の500件に達しています。</p>}
    {visibleWords.length ? <table className="personal-word-table">
      <thead><tr><th scope="col"><span className="sr-only">有効</span></th><th scope="col">読み</th><th scope="col">表記</th><th scope="col">種類</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead>
      <tbody>{visibleWords.map(word => <tr key={word.id} className={word.enabled ? "" : "word-disabled"}>
        <td><input type="checkbox" aria-label={`${word.text} を有効にする`} checked={word.enabled}
          onChange={event => { const enabled = event.currentTarget.checked; onChange(words.map(w => w.id === word.id ? { ...w, enabled } : w)); }} /></td>
        <td>{word.reading}</td><td><strong>{word.text}</strong></td><td>{kinds[word.pos]}</td>
        <td><button type="button" className="icon-button" aria-label={`${word.text} を個人語彙から削除`}
          onClick={() => onChange(words.filter(w => w.id !== word.id))}><Trash2 size={16} aria-hidden="true" /></button></td>
      </tr>)}</tbody>
    </table> : <p className="empty-state">{words.length ? "一致する語彙がありません。" : "個人語彙はまだ登録されていません。"}</p>}
  </div>;
}
