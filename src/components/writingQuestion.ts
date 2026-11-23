import { Prec, StateEffect, StateField } from "@codemirror/state";
import { keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { buildDocumentVocabularyProfile } from "../lib/documentVocabulary";
import { analyzeInput } from "../lib/inputAnalysis";

function nextQuestion(line: string, document: string): string {
  const sentence = line.trimEnd().slice(0, -1).split(/[。！？]/u).pop() ?? "";
  const topic = buildDocumentVocabularyProfile(document).terms.find(term => sentence.includes(term));
  if (/延期|見送|中止/u.test(sentence)) return "判断の決め手は何だった？";
  if (/減っ|増え|改善|短縮|速く|遅く/u.test(sentence)) return "どの場面で差がいちばん出た？";
  if (/困っ|問題|失敗|できなかった/u.test(sentence)) return "どんなときに起きた？";
  if (/予定|つもり|したい/u.test(sentence)) return "まず何から始める？";
  if (topic) return `「${topic}」について、具体例を一つ挙げると？`;
  return "たとえば、どんな場面だった？";
}

const dismiss = StateEffect.define<void>();
const question = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    if (tr.effects.some(effect => effect.is(dismiss))) return null;
    if (!tr.docChanged) return tr.selection ? null : value;
    if (!tr.isUserEvent("input") || tr.isUserEvent("input.paste") || !tr.newSelection.main.empty) return null;
    const cursor = tr.newSelection.main.head;
    const line = tr.newDoc.lineAt(cursor);
    if (line.number < 2 || line.text.trim() || cursor !== line.to) return null;
    let newline = false;
    tr.changes.iterChanges((_a, _b, _c, end, inserted) => {
      if (end === cursor && /^\n[ \t]*$/u.test(inserted.toString())) newline = true;
    });
    if (!newline) return null;
    const previous = tr.newDoc.line(line.number - 1);
    if (!previous.text.trimEnd().endsWith("。")) return null;
    const document = tr.newDoc.toString();
    const period = previous.from + previous.text.trimEnd().length - 1;
    if (!analyzeInput(document).some(s => s.kind === "text" && s.from <= period && period < s.to)) return null;
    const text = nextQuestion(previous.text, document);
    return { pos: cursor, above: false, create() {
      const dom = window.document.createElement("aside");
      dom.className = "writing-question";
      dom.setAttribute("role", "status");
      dom.textContent = text;
      return { dom };
    } };
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
