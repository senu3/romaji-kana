# Kana engine

Application-owned Rust kana/kanji search. No Mozc runtime or server is linked.
`data/` contains the ten public base dictionaries, their matching connection
matrix, POS definitions and vocabulary filter from the revision in `manifest.json`.
The auxiliary/manual dictionaries, Mozc rewriters, prediction models and segmenter
are not included. This is not a reproduction of Mozc's conversion quality.

Run `node tools/import-mozc.mjs` from the repository root to reproduce the gzip
sources. The manifest records SHA-256 hashes of the uncompressed upstream files.
Redistributions must retain `data/NOTICE.txt`, `data/MOZC-LICENSE` and attribution.
The notices are embedded with the application engine as well as kept in source.

`cargo test --manifest-path src-engine/Cargo.toml` tests the same implementation
used by Tauri and the development/evaluation JSON-lines process. Reading and token
offsets in this protocol count Unicode scalar values, not JavaScript UTF-16 units.

Search builds a reading lattice, computes Viterbi prefix costs, then enumerates
complete paths with backward A*. N-best is deduplicated by surface text. A literal
candidate is always retained. Budgets: 160 input scalars, 30,000 nodes, 50,000 queued
paths, 10,000 expansions, 32 requested results plus the literal fallback. Budget
exhaustion is reported, never interpreted as an impossible pronunciation.

Verification checks existence of a text/reading alignment independently of N-best.
Missing dictionary paths remain unverified; this is not an exhaustive reading
dictionary or an assertion about semantics, intent, or grammatical correctness.
