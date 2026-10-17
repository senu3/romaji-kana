import { useState, type FormEvent } from "react";
import type { PersonalWord } from "../lib/kanaEngine";
import { normalizePersonalDictionary } from "../lib/settings";
import { createId } from "../lib/id";

export function PersonalDictionary({ words, onChange }: { words: PersonalWord[]; onChange: (words: PersonalWord[]) => void }) {
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
    setReading(""); setText(""); setError("");
  };
  return <div>
    <p>人名・社名・専門用語を変換候補に追加します。同じ読みに複数の表記を登録できます。</p>
    <form className="dictionary-add-form" onSubmit={add}>
      <label className="field"><span>かな読み</span><input aria-label="個人語彙のかな読み" value={reading} maxLength={80}
        placeholder="てすとしゃ" onChange={event => setReading(event.currentTarget.value)} /></label>
      <label className="field"><span>表記</span><input aria-label="個人語彙の表記" value={text} maxLength={80}
        placeholder="試験社" onChange={event => setText(event.currentTarget.value)} /></label>
      <label className="field"><span>種類</span><select aria-label="個人語彙の種類" value={pos}
        onChange={event => setPos(event.currentTarget.value as PersonalWord["pos"])}>
        <option value="noun">一般名詞</option><option value="proper">固有名詞</option>
        <option value="person">人名</option><option value="organization">組織名</option>
      </select></label>
      <button className="primary-button" type="submit" disabled={!reading.trim() || !text.trim() || words.length >= 500}>語彙を追加</button>
    </form>
    <p role="status">{error}</p>
    <p>{words.length} / 500件</p>
    <div className="dictionary-list">{words.map(word => <article className="dictionary-entry" key={word.id}>
      <label className="dictionary-enable"><input type="checkbox" checked={word.enabled}
        onChange={event => onChange(words.map(w => w.id === word.id ? { ...w, enabled: event.currentTarget.checked } : w))} />有効</label>
      <div className="dictionary-entry-fields"><span>{word.reading}</span><strong>{word.text}</strong>
        <span>{{ noun: "一般名詞", proper: "固有名詞", person: "人名", organization: "組織名" }[word.pos]}</span></div>
      <button type="button" className="icon-button" aria-label={`${word.text} を個人語彙から削除`}
        onClick={() => onChange(words.filter(w => w.id !== word.id))}>削除</button>
    </article>)}</div>
    {!words.length && <p className="empty-state">個人語彙はまだ登録されていません。</p>}
  </div>;
}
