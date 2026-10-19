//! Application-owned converter. Mozc contributes data, not executable engine code.
use flate2::read::GzDecoder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BinaryHeap, HashSet},
    io::Read,
    sync::OnceLock,
};

const MAX_READING: usize = 160;
const MAX_NODES: usize = 30_000;
const MAX_EXPANSIONS: usize = 10_000;
const MAX_AGENDA: usize = 50_000;
const NOUN: u16 = 1851;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserWord {
    pub id: String,
    pub reading: String,
    pub text: String,
    #[serde(default)]
    pub pos: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub reading: String,
    #[serde(default)]
    pub words: Vec<UserWord>,
    #[serde(default = "default_limit")]
    pub limit: usize,
}
fn default_limit() -> usize {
    16
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub reading: String,
    pub text: String,
    pub from: usize,
    pub to: usize,
    pub source: String,
    pub entry_id: String,
    pub lid: u16,
    pub rid: u16,
    pub word_cost: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub text: String,
    pub reading: String,
    pub cost: i64,
    pub tokens: Vec<Token>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub candidates: Vec<Candidate>,
    pub truncated: bool,
    pub dictionary_revision: &'static str,
}

#[derive(Clone)]
struct Entry {
    reading: String,
    text: String,
    lid: u16,
    rid: u16,
    cost: i32,
    id: String,
}

#[derive(Default)]
struct Trie {
    children: BTreeMap<char, Trie>,
    entries: Vec<usize>,
}
impl Trie {
    fn insert(&mut self, key: &str, index: usize) {
        let mut node = self;
        for ch in key.chars() {
            node = node.children.entry(ch).or_default();
        }
        node.entries.push(index);
    }
    fn matches(&self, chars: &[char], start: usize) -> Vec<(usize, usize)> {
        let mut node = self;
        let mut found = Vec::new();
        for (offset, ch) in chars[start..].iter().enumerate() {
            let Some(next) = node.children.get(ch) else {
                break;
            };
            node = next;
            found.extend(node.entries.iter().map(|&id| (start + offset + 1, id)));
        }
        found
    }

    #[cfg(feature = "evaluation")]
    fn completions(&self, prefix: &[char]) -> Vec<usize> {
        let mut node = self;
        for ch in prefix {
            let Some(next) = node.children.get(ch) else {
                return vec![];
            };
            node = next;
        }
        let mut stack = vec![node];
        let mut found = Vec::new();
        let mut visited = 0;
        while let Some(node) = stack.pop() {
            visited += 1;
            if visited > 4096 || found.len() >= 256 {
                break;
            }
            found.extend(&node.entries);
            stack.extend(node.children.values().rev());
        }
        found
    }
}

pub struct Engine {
    entries: Vec<Entry>,
    trie: Trie,
    matrix: Vec<i32>,
    size: usize,
}

fn unzip(bytes: &[u8]) -> Result<String, String> {
    let mut text = String::new();
    GzDecoder::new(bytes)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    Ok(text)
}

static ENGINE: OnceLock<Result<Engine, String>> = OnceLock::new();
pub fn engine() -> Result<&'static Engine, String> {
    ENGINE
        .get_or_init(Engine::load)
        .as_ref()
        .map_err(Clone::clone)
}

impl Engine {
    fn load() -> Result<Self, String> {
        let connection = unzip(include_bytes!("../data/connection_single_column.txt.gz"))?;
        let mut lines = connection.lines();
        let size = lines
            .next()
            .ok_or("Missing matrix size")?
            .parse::<usize>()
            .map_err(|e| e.to_string())?;
        let matrix = lines
            .map(|s| s.parse::<i32>().map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        if matrix.len() != size * size {
            return Err("Invalid connection matrix".into());
        }
        let filters = unzip(include_bytes!("../data/dictionary_filter.tsv.gz"))?;
        let filters: Vec<(Regex, Regex)> = filters
            .lines()
            .filter(|s| !s.starts_with('#') && !s.is_empty())
            .map(|s| {
                let (k, v) = s.split_once('\t').ok_or("Invalid dictionary filter")?;
                Ok((
                    Regex::new(&format!("^(?:{k})$")).map_err(|e| e.to_string())?,
                    Regex::new(&format!("^(?:{v})$")).map_err(|e| e.to_string())?,
                ))
            })
            .collect::<Result<_, String>>()?;
        let dictionaries: [&[u8]; 10] = [
            include_bytes!("../data/dictionary00.txt.gz"),
            include_bytes!("../data/dictionary01.txt.gz"),
            include_bytes!("../data/dictionary02.txt.gz"),
            include_bytes!("../data/dictionary03.txt.gz"),
            include_bytes!("../data/dictionary04.txt.gz"),
            include_bytes!("../data/dictionary05.txt.gz"),
            include_bytes!("../data/dictionary06.txt.gz"),
            include_bytes!("../data/dictionary07.txt.gz"),
            include_bytes!("../data/dictionary08.txt.gz"),
            include_bytes!("../data/dictionary09.txt.gz"),
        ];
        let mut entries = Vec::new();
        let mut trie = Trie::default();
        for (file, bytes) in dictionaries.iter().enumerate() {
            for (line, row) in unzip(bytes)?.lines().enumerate() {
                let fields: Vec<_> = row.split('\t').collect();
                if fields.len() < 5 {
                    return Err(format!("Invalid dictionary row {file}:{line}"));
                }
                if filters
                    .iter()
                    .any(|(k, v)| k.is_match(fields[0]) && v.is_match(fields[4]))
                {
                    continue;
                }
                let entry = Entry {
                    reading: fields[0].into(),
                    text: fields[4].into(),
                    lid: fields[1].parse::<u16>().map_err(|e| e.to_string())?,
                    rid: fields[2].parse::<u16>().map_err(|e| e.to_string())?,
                    cost: fields[3].parse::<i32>().map_err(|e| e.to_string())?,
                    id: format!("mozc:{file}:{line}"),
                };
                if entry.reading.is_empty()
                    || entry.lid as usize >= size
                    || entry.rid as usize >= size
                {
                    return Err("Invalid dictionary entry".into());
                }
                trie.insert(&entry.reading, entries.len());
                entries.push(entry);
            }
        }
        Ok(Self {
            entries,
            trie,
            matrix,
            size,
        })
    }

    fn transition(&self, rid: u16, lid: u16) -> i64 {
        self.matrix[rid as usize * self.size + lid as usize] as i64
    }

    pub fn search(&self, request: &SearchRequest) -> Result<SearchResult, String> {
        let chars: Vec<char> = request.reading.chars().collect();
        if chars.is_empty() || chars.len() > MAX_READING || request.words.len() > 500 {
            return Err("Reading must contain 1–160 characters; at most 500 personal words".into());
        }
        let mut nodes: Vec<Node> = Vec::new();
        let mut ending: Vec<Vec<usize>> = vec![Vec::new(); chars.len() + 1];
        let mut truncated = false;
        for start in 0..chars.len() {
            let mut tokens = Vec::new();
            for (end, index) in self.trie.matches(&chars, start) {
                let e = &self.entries[index];
                tokens.push(Token {
                    reading: e.reading.clone(),
                    text: e.text.clone(),
                    from: start,
                    to: end,
                    source: "mozc".into(),
                    entry_id: e.id.clone(),
                    lid: e.lid,
                    rid: e.rid,
                    word_cost: e.cost,
                });
            }
            for word in &request.words {
                let key: Vec<char> = word.reading.chars().collect();
                if key.is_empty()
                    || key.len() > 80
                    || word.text.chars().count() > 80
                    || word.text.is_empty()
                {
                    continue;
                }
                if chars[start..].starts_with(&key) {
                    let id = match word.pos.as_str() {
                        "person" => 1921,
                        "organization" => 1929,
                        "proper" => 1920,
                        _ => NOUN,
                    };
                    tokens.push(Token {
                        reading: word.reading.clone(),
                        text: word.text.clone(),
                        from: start,
                        to: start + key.len(),
                        source: "user".into(),
                        entry_id: word.id.clone(),
                        lid: id,
                        rid: id,
                        word_cost: 3000,
                    });
                }
            }
            // An exact literal route is always available. No unknown Kanji is invented.
            let literal = chars[start].to_string();
            tokens.push(Token {
                reading: literal.clone(),
                text: literal,
                from: start,
                to: start + 1,
                source: "literal".into(),
                entry_id: format!("literal:{start}"),
                lid: NOUN,
                rid: NOUN,
                word_cost: 12_000,
            });
            for token in tokens {
                if nodes.len() >= MAX_NODES {
                    truncated = true;
                    break;
                }
                let (best, prev) = if start == 0 {
                    (self.transition(0, token.lid), None)
                } else {
                    ending[start]
                        .iter()
                        .map(|&i| {
                            (
                                nodes[i].best + self.transition(nodes[i].token.rid, token.lid),
                                Some(i),
                            )
                        })
                        .min_by_key(|&(cost, _)| cost)
                        .ok_or("No complete path")?
                };
                let end = token.to;
                nodes.push(Node {
                    best: best + token.word_cost as i64,
                    token,
                    prev,
                });
                ending[end].push(nodes.len() - 1);
            }
            if truncated {
                break;
            }
        }
        let limit = request.limit.clamp(1, 32);
        let mut agenda = BinaryHeap::new();
        for &last in &ending[chars.len()] {
            let suffix = self.transition(nodes[last].token.rid, 0);
            agenda.push(Path {
                estimate: nodes[last].best + suffix,
                suffix,
                reverse: vec![last],
            });
        }
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        let mut expansions = 0;
        while let Some(path) = agenda.pop() {
            if expansions >= MAX_EXPANSIONS {
                truncated = true;
                break;
            }
            expansions += 1;
            let current = *path.reverse.last().unwrap();
            let node = &nodes[current];
            if node.token.from == 0 {
                let tokens: Vec<Token> = path
                    .reverse
                    .iter()
                    .rev()
                    .map(|&i| nodes[i].token.clone())
                    .collect();
                let text: String = tokens.iter().map(|t| t.text.as_str()).collect();
                if seen.insert(text.clone()) {
                    candidates.push(Candidate {
                        text,
                        reading: request.reading.clone(),
                        cost: path.estimate,
                        tokens,
                    });
                }
                if candidates.len() >= (limit * 4).min(128) {
                    break;
                }
                continue;
            }
            for &previous in &ending[node.token.from] {
                if agenda.len() >= MAX_AGENDA {
                    truncated = true;
                    break;
                }
                let suffix = path.suffix
                    + node.token.word_cost as i64
                    + self.transition(nodes[previous].token.rid, node.token.lid);
                let mut reverse = path.reverse.clone();
                reverse.push(previous);
                agenda.push(Path {
                    estimate: nodes[previous].best + suffix,
                    suffix,
                    reverse,
                });
            }
        }
        // Reserve space for distinct boundary patterns before filling by cost.
        // Surface variants of one segmentation must not exhaust the whole pool.
        let mut boundary_counts = BTreeMap::<Vec<usize>, usize>::new();
        let mut diverse = Vec::new();
        let mut deferred = Vec::new();
        for candidate in candidates {
            let signature = candidate.tokens.iter().map(|t| t.to).collect::<Vec<_>>();
            let count = boundary_counts.entry(signature).or_default();
            if *count < (limit / 2).max(1) && diverse.len() < limit {
                *count += 1;
                diverse.push(candidate);
            } else {
                deferred.push(candidate);
            }
        }
        for candidate in deferred {
            if diverse.len() < limit {
                diverse.push(candidate);
            }
        }
        let mut candidates = diverse;
        candidates.sort_by_key(|c| c.cost);
        // Unknown kana must trigger correction/speculation in the application,
        // never become a normal passthrough candidate. Dictionary-backed kana
        // spellings remain valid; non-kana literals can still be preserved.
        candidates.retain(|candidate| {
            candidate.tokens.iter().all(|token| {
                token.source != "literal"
                    || !token
                        .reading
                        .chars()
                        .any(|ch| ('\u{3040}'..='\u{30ff}').contains(&ch))
            })
        });
        Ok(SearchResult {
            candidates,
            truncated,
            dictionary_revision: "0136c35782536cb43d710575c311cd4185982738",
        })
    }

    /// Prefix completion proposes readings; it never silently changes typed characters.
    #[cfg(feature = "evaluation")]
    pub fn complete(&self, reading: &str, words: &[UserWord]) -> Vec<String> {
        let chars: Vec<char> = reading.chars().collect();
        if chars.len() < 2
            || chars.len() > MAX_READING
            || !chars
                .iter()
                .all(|c| ('ぁ'..='ゖ').contains(c) || *c == 'ー')
        {
            return vec![];
        }
        for start in 0..chars.len() - 1 {
            let prefix = &chars[start..];
            let before: String = chars[..start].iter().collect();
            let mut found: Vec<(usize, i32, String)> = Vec::new();
            for index in self.trie.completions(prefix) {
                let entry = &self.entries[index];
                let length = entry.reading.chars().count();
                if length > prefix.len() && length <= prefix.len() + 12 {
                    found.push((
                        length - prefix.len(),
                        entry.cost,
                        format!("{before}{}", entry.reading),
                    ));
                }
            }
            for word in words {
                let key: Vec<char> = word.reading.chars().collect();
                if key.len() > prefix.len()
                    && key.len() <= prefix.len() + 12
                    && key.starts_with(prefix)
                {
                    found.push((
                        key.len() - prefix.len(),
                        3000,
                        format!("{before}{}", word.reading),
                    ));
                }
            }
            found.sort();
            let mut seen = HashSet::new();
            let results: Vec<String> = found
                .into_iter()
                .map(|(_, _, key)| key)
                .filter(|key| key.chars().count() <= MAX_READING && seen.insert(key.clone()))
                .take(3)
                .collect();
            if !results.is_empty() {
                return results;
            }
        }
        vec![]
    }

    /// Existence of a surface/reading alignment, independent of ranked N-best results.
    /// A missing path is unknown: this dictionary cannot establish exhaustive pronunciation.
    pub fn verify(&self, text: &str, reading: &str, words: &[UserWord]) -> &'static str {
        let surface: Vec<char> = text.chars().collect();
        let kana: Vec<char> = reading.chars().collect();
        if surface.len() > 320 || kana.len() > MAX_READING {
            return "unverified";
        }
        let mut queue = vec![(0, 0)];
        let mut seen = HashSet::new();
        while let Some((r, s)) = queue.pop() {
            if !seen.insert((r, s)) {
                continue;
            }
            if r == kana.len() && s == surface.len() {
                return "verified";
            }
            if seen.len() > MAX_NODES {
                return "unverified";
            }
            if r == kana.len() || s == surface.len() {
                continue;
            }
            if kana[r] == surface[s] {
                queue.push((r + 1, s + 1));
            }
            for (end, index) in self.trie.matches(&kana, r) {
                let value: Vec<char> = self.entries[index].text.chars().collect();
                if surface[s..].starts_with(&value) {
                    queue.push((end, s + value.len()));
                }
            }
            for word in words {
                let key: Vec<char> = word.reading.chars().collect();
                let value: Vec<char> = word.text.chars().collect();
                if !key.is_empty()
                    && !value.is_empty()
                    && kana[r..].starts_with(&key)
                    && surface[s..].starts_with(&value)
                {
                    queue.push((r + key.len(), s + value.len()));
                }
            }
        }
        "unverified"
    }
}

struct Node {
    token: Token,
    best: i64,
    #[allow(dead_code)]
    prev: Option<usize>,
}
#[derive(Eq, PartialEq)]
struct Path {
    estimate: i64,
    suffix: i64,
    reverse: Vec<usize>,
}
impl Ord for Path {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .estimate
            .cmp(&self.estimate)
            .then_with(|| other.reverse.cmp(&self.reverse))
            .then_with(|| other.suffix.cmp(&self.suffix))
    }
}
impl PartialOrd for Path {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase")]
pub enum Request {
    Notices,
    #[cfg(feature = "evaluation")]
    Complete {
        reading: String,
        #[serde(default)]
        words: Vec<UserWord>,
    },
    Search {
        #[serde(flatten)]
        request: SearchRequest,
    },
    Verify {
        text: String,
        reading: String,
        #[serde(default)]
        words: Vec<UserWord>,
    },
}
pub fn execute(request: Request) -> Result<serde_json::Value, String> {
    match request {
        Request::Notices => Ok(serde_json::json!({
            "revision": "0136c35782536cb43d710575c311cd4185982738",
            "notice": include_str!("../data/NOTICE.txt"),
            "license": include_str!("../data/MOZC-LICENSE"),
        })),
        #[cfg(feature = "evaluation")]
        Request::Complete { reading, words } => {
            if words.len() > 500 {
                return Err("Too many personal words".into());
            }
            Ok(serde_json::json!({ "readings": engine()?.complete(&reading, &words) }))
        }
        Request::Search { request } => {
            serde_json::to_value(engine()?.search(&request)?).map_err(|e| e.to_string())
        }
        Request::Verify {
            text,
            reading,
            words,
        } => {
            if words.len() > 500 {
                return Err("Too many personal words".into());
            }
            Ok(serde_json::json!({ "status": engine()?.verify(&text, &reading, &words) }))
        }
    }
}

#[cfg(test)]
#[path = "../../tests/unit/engine.rs"]
mod tests;
