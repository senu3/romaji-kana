import { useState } from "react";
import { clearConversionLearning, conversionLearningChoices, forgetConversionChoice } from "../lib/conversionLearning";

export function ConversionLearningPanel() {
  const [choices, setChoices] = useState(conversionLearningChoices);
  const [status, setStatus] = useState("");
  const update = (success: boolean) => {
    setChoices(conversionLearningChoices());
    setStatus(success ? "学習履歴を削除しました。次の変換から反映します。" : "学習履歴を削除できませんでした。");
  };
  return <div className="dictionary-learning-content">
    {!choices.length && <p className="empty-state">学習履歴はありません。</p>}
    <div className="dictionary-list">{choices.map(choice => <article className="dictionary-entry" key={JSON.stringify([choice.reading, choice.text])}>
      <div className="dictionary-entry-fields"><span>{choice.reading}</span><strong>{choice.text}</strong><span>確定 {choice.count} 回</span></div>
      <button type="button" className="text-button" aria-label={`${choice.reading} → ${choice.text} の学習を削除`}
        onClick={() => update(forgetConversionChoice(choice.reading, choice.text))}>削除</button>
    </article>)}</div>
    <details className="dictionary-help"><summary>学習履歴について</summary><p>確定した読みと表記を、この端末の次の変換で優先します。履歴を削除しても個人語彙や文書は残ります。</p></details>
    {choices.length > 0 && <button type="button" className="text-button learning-clear" onClick={() => update(clearConversionLearning())}>学習履歴をすべて削除</button>}
    <p role="status" className="detected-vocabulary-status">{status}</p>
  </div>;
}
