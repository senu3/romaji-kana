// Keep prompt guidance and executable validation on the same existing limit.
import { wordCompletionRule } from "./conversionRules";
export const MAX_WORD_COMPLETION_KANA = wordCompletionRule.maximumAddedKana;
