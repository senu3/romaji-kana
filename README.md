# Romaji Kana

A Tauri v2, React, TypeScript, and CodeMirror 6 Markdown editor that converts rough romaji input into natural Japanese through a local Ollama model.

## Development

```bash
npm install
npm run dev
```

For the desktop shell:

```bash
npm run tauri dev
```

## Verification

```bash
npm test
npm run build
```

Ollama is expected to be running locally. The default API URL is `http://localhost:11434`, and the default model is `gemma3`.
