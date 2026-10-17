import type { LocalGenerateResponse } from "./ollamaProxy";

export function throwIfConversionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("変換候補の生成を中止しました。", "AbortError");
  }
}

export function generateWithAbort<T>(
  createPromise: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return createPromise();
  }
  throwIfConversionAborted(signal);
  const promise = createPromise();

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("変換候補の生成を中止しました。", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function generatedText(result: LocalGenerateResponse): string {
  if ("response" in result && result.response) {
    return result.response;
  }
  if ("message" in result && result.message?.content) {
    return result.message.content;
  }
  if ("choices" in result) {
    return result.choices?.[0]?.message?.content ?? "";
  }

  return "";
}

export function stripThinkBlock(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}
