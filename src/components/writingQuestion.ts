import { Prec, StateEffect, StateField } from "@codemirror/state";
import { keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { buildDocumentVocabularyProfile } from "../lib/documentVocabulary";
import { analyzeInput } from "../lib/inputAnalysis";

import { commitEditorText } from "../lib/editorCommit";
import { generatedText, stripThinkBlock } from "../lib/generationUtils";
import { currentProviderBaseUrl } from "../lib/modelProvider";
import { defaultOllamaTransport } from "../lib/ollamaProxy";
import { loadSettings } from "../lib/settings";

function writingPrompt(line: string, terms: string[]) {
  const sentence = line.trimEnd().slice(0, -1).split(/[。！？!?．.]/u).pop() ?? "";
  const comma = /[、，,]$/u.test(line);
  const topic = terms.find(term => sentence.includes(term));
  // The closing predicate determines the writer's intent even when the
  // subject includes a word like 改善 or 延期.
  if (/(?:教えて(?:ください|ほしい|欲しい)?|知りたい(?:です)?|説明して(?:ください|ほしい)?|ですか|ますか)$/u.test(sentence.trim())) {
    if (/仕組み|しくみ|内部|どのように動|どう動/u.test(sentence)) return {
      question: "特に知りたいのは、内部のどの部分？",
      continuation: "内部の動作が知りたいです。",
    };
    if (/なぜ|理由|原因|どうして/u.test(sentence)) return {
      question: "理由のどこを詳しく聞きたい？", continuation: "特に、何がいちばん大きく影響しているのか知りたいです。",
    };
    if (/手順|方法|やり方|使い方/u.test(sentence)) return {
      question: "どの手順から説明してほしい？", continuation: "最初に何をすればよいか、順を追って説明してほしいです。",
    };
    return null;
  }
  // A concessive clause leaves the outcome open. Offer alternative endings.
  if (/何を(?:書|か)いても$/u.test(sentence.trim())) return {
    question: "書く内容が変わっても、同じなのは何？",
    continuation: "結局、同じ結論にたどり着く。",
    alternative: "本当に伝えたいことだけが抜け落ちてしまう。",
  };
  if (/延期|見送|中止/u.test(sentence)) return {
    question: "判断の決め手は何だった？",
    continuation: comma ? "残った作業を洗い出してから、新しい日程を決めることにした。" : "次の日程を決める前に、何を終える必要があるか整理しておきたい。",
  };
  if (/減っ|増え|改善|短縮|速く|遅く/u.test(sentence)) return {
    question: "どの場面で差がいちばん出た？",
    continuation: comma ? "同じ操作を繰り返したときにも差が出るか確かめたい。" : "次は条件をそろえて試し、どの場面で差が大きくなるかを比べたい。",
  };
  if (/困っ|問題|失敗|できなかった/u.test(sentence)) return {
    question: "どんなときに起きた？",
    continuation: comma ? "直前の操作を一つずつたどって、同じことが起きるか試した。" : "まず直前の状態を記録し、条件を一つずつ変えて原因を絞りたい。",
  };
  if (/予定|つもり|したい/u.test(sentence)) return {
    question: "まず何から始める？", continuation: "まず小さく試し、その結果を見て次に取り組む範囲を決めたい。",
  };
  if (topic && /試した|使ってみた/u.test(sentence)) return {
    question: `「${topic}」を試して気づいたことは？`,
    continuation: `次は普段の作業でも${topic}を使って、使い勝手を確かめたい。`,
  };
  return null;
}

async function predictContinuation(line: string, terms: string[], signal: AbortSignal) {
  const settings = loadSettings();
  const response = await defaultOllamaTransport.generate(settings.modelProvider, currentProviderBaseUrl(settings), {
    model: settings.modelName, stream: false, think: false,
    system: "日本語原稿の続きを執筆する。末尾が読点なら同じ文の後半から、句点なら次の文から始める。直前の内容と文体を引き継いで一〜二文を最後まで書く。入力の繰り返し、見出し、助言は不要。未提示の数値や人名を作らない。書き手が説明を求めている場合は、その人が知りたい範囲を同じ視点で補う。相手として回答したり例を要求したりしない。本文だけ返す。",
    prompt: JSON.stringify({ line: line.slice(-1500), vocabulary: terms }), options: { temperature: 0.55 },
  }, 12000, signal);
  const text = stripThinkBlock(generatedText(response)).trim();
  return text.length >= 8 && text.length <= 240 && /[。！？][」』）]?$/u.test(text) ? text : "";
}

const dismiss = StateEffect.define<void>();
const question = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    if (tr.effects.some(effect => effect.is(dismiss))) return null;
    if (!tr.docChanged) return tr.selection && !tr.selection.eq(tr.startState.selection) ? null : value;
    const typing = tr.isUserEvent("input.type") || tr.isUserEvent("input.convert") || tr.isUserEvent("input.ghostAccept");
    if (!typing || !tr.newSelection.main.empty) return null;
    const cursor = tr.newSelection.main.head;
    let punctuationInserted = false;
    tr.changes.iterChanges((_from, _to, _newFrom, end, inserted) => {
      if (end === cursor && /[。、．，.,]$/u.test(inserted.toString())) punctuationInserted = true;
    });
    if (!punctuationInserted) return null;
    const line = tr.newDoc.lineAt(cursor);
    const context = tr.newDoc.sliceString(line.from, cursor);
    if (!context.slice(0, -1).trim() || /[0-9][.,]$/u.test(context)) return null;
    const document = tr.newDoc.toString();
    if (!analyzeInput(document).some(s => s.kind === "text" && s.from < cursor && cursor <= s.to)) return null;
    const terms = buildDocumentVocabularyProfile(document).terms;
    const prompt = writingPrompt(context, terms);
    // A short connective alone provides too little context for either source.
    // Otherwise the model can propose a continuation independently of templates.
    if (!prompt && (context.slice(0, -1).split(/[。！？!?．.]/u).pop() ?? "").trim().length < 5) return null;
    const tooltip: Tooltip = { pos: cursor, above: false, create(view) {
      const dom = window.document.createElement("aside");
      dom.className = "writing-question";
      if (prompt) {
        const hint = window.document.createElement("div");
        hint.setAttribute("role", "status");
        hint.textContent = prompt.question;
        dom.append(hint);
      }
      function addCandidate(text: string) {
        const button = window.document.createElement("button");
        button.type = "button";
        button.textContent = text;
        button.title = "クリックして続きを挿入";
        button.onmousedown = event => event.preventDefault();
        button.onclick = () => {
          if (view.composing || view.state.field(question) !== tooltip || view.state.selection.main.head !== cursor) return;
          commitEditorText(view, { from: cursor, to: cursor, original: "", text, cursor: "end", userEvent: "input.autosuggest" });
          view.focus();
        };
        dom.append(button);
      }
      if (prompt) addCandidate(prompt.continuation);
      if (prompt?.alternative) addCandidate(prompt.alternative);
      const controller = new AbortController();
      const timer = setTimeout(() => {
        void predictContinuation(context, terms, controller.signal).then(text => {
          if (!controller.signal.aborted && text && text !== prompt?.continuation && text !== prompt?.alternative) {
            addCandidate(text);
            view.requestMeasure();
          }
        }).catch(() => { /* The local example remains usable offline. */ });
      }, 350);
      return { dom, destroy() { clearTimeout(timer); controller.abort(); } };
    } };
    return tooltip;
  },
  provide: field => showTooltip.from(field),
});

export const writingQuestion = [
  question,
  Prec.highest(keymap.of([{ key: "Escape", run(view) {
    if (!view.state.field(question)) return false;
    view.dispatch({ effects: dismiss.of() });
    return true;
  } }])),
];
