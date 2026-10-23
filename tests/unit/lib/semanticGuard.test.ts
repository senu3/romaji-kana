import { expect, it } from "vitest";
import { hasSemanticConflict } from "../../../src/lib/semanticGuard";

it.each([
  ["あしたはいく。", "あしたはけっせきします。"],
  ["あしたはいく。", "あしたはいけません。"],
  ["あしたはいかない。", "あしたはしゅっせきします。"],
  ["まだかくにんしていない。", "かくにんしました。"],
  ["おわらなかった。", "おわっていない。"],
  ["きじをようやくしてください。", "きじをようやくしました。"],
])("rejects a recognizable intent conflict: %s", (a, b) => expect(hasSemanticConflict(a, b)).toBe(true));
it.each([
  ["あしたはいく。", "あしたはしゅっせきします。"],
  ["あしたはいかない。", "あしたはけっせきします。"],
  ["ほうこうをかえないでください。", "おなじてじゅんですすめてください。"],
  ["あしたはいく。", "あしたのことをそうだんします。"], // Unknown relation, not claimed safe.
  ["あんない", "あんない"],
])("does not reject equivalent or unclassified wording: %s", (a, b) => expect(hasSemanticConflict(a, b)).toBe(false));
