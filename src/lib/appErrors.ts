
export function formatConversionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch|network|failed|ECONNREFUSED|Load failed/i.test(message)) {
    return "選択中のローカルモデルプロバイダーに接続できません。設定した URL で起動しているか確認してください。";
  }
  return message || "変換に失敗しました。";
}

export function formatOllamaConnectionError(error: unknown, label: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message)) {
    return `${label} の接続確認がタイムアウトしました。${label} が起動していて、選択中のモデルを読み込めるか確認してください。`;
  }
  if (/fetch|network|failed|ECONNREFUSED|Load failed/i.test(message)) {
    return `${label} に接続できません。設定した URL で起動しているか確認してください。`;
  }
  return message || `${label} の接続確認に失敗しました。`;
}

export function formatFileError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "ファイル操作に失敗しました。");
}
