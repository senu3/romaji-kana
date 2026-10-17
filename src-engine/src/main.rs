use std::io::{self, BufRead, Write};
fn main() {
    for line in io::stdin().lock().lines() {
        let response = line
            .map_err(|e| e.to_string())
            .and_then(|s| {
                serde_json::from_str::<kana_engine::Request>(&s).map_err(|e| e.to_string())
            })
            .and_then(kana_engine::execute);
        let value = match response {
            Ok(value) => value,
            Err(error) => serde_json::json!({ "error": error }),
        };
        println!("{value}");
        if io::stdout().flush().is_err() {
            break;
        }
    }
}
