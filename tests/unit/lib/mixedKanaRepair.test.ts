import { expect, it, vi } from "vitest";
import { findMixedKanaRepair } from "../../../src/lib/mixedKanaRepair";

it.each(["控えてくDさい", "控えてくＤさい", "IDdんわ"])("keeps intentional letters in %s", async input => {
  const lookup = vi.fn();
  expect(await findMixedKanaRepair(input, input.length, lookup)).toBeNull();
  expect(lookup).not.toHaveBeenCalled();
});
