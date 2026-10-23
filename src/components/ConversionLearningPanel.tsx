import { useState } from "react";
import { clearConversionLearning, conversionLearningChoices, forgetConversionChoice } from "../lib/conversionLearning";

export function ConversionLearningPanel() {
  const [choices, setChoices] = useState(conversionLearningChoices);
  const [status, setStatus] = useState("");
  const update = (success: boolean) => {
    setChoices(conversionLearningChoices());
    setStatus(success ? "学習履歴を削除しました。次の変換から反映します。" : "学習履歴を削除できませんでした。");
  };
  return <div>
    <p>確定した読みと表記を、この端末の次の変換で優先します。個人語彙や文書は削除されません。</p>
    <button type="button" className="text-button" disabled={!choices.length} onClick={() => update(clearConversionLearning())}>学習履歴をすべて削除</button>
    {!choices.length && <p className="empty-state">学習履歴はありません。</p>}
    <div className="dictionary-list">{choices.map(choice => <article className="dictionary-entry" key={JSON.stringify([choice.reading, choice.text])}>
      <div className="dictionary-entry-fields"><span>{choice.reading}</span><strong>{choice.text}</strong><span>確定 {choice.count} 回</span></div>
      <button type="button" className="text-button" aria-label={`${choice.reading} → ${choice.text} の学習を削除`}
        onClick={() => update(forgetConversionChoice(choice.reading, choice.text))}>削除</button>
    </article>)}</div>
    <p role="status">{status}</p>
  </div>;
}
