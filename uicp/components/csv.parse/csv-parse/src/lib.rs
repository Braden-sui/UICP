//! csv.parse@1.2.0 component entrypoint.
//! WHY: Keep component logic self-contained so bindgen exports stay minimal.

#![allow(clippy::missing_errors_doc)]

mod bindings;

use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine as _;
use bindings::exports::uicp::task_csv_parse::csv::{Guest, Rows};
use csv::{ReaderBuilder, Trim};
use percent_encoding::percent_decode_str;

const ERROR_DATA_URI: &str = "E-UICP-701";
const ERROR_UTF8: &str = "E-UICP-702";
const ERROR_CSV: &str = "E-UICP-703";

struct Component;

impl Guest for Component {
    fn run(job_id: String, input: String, has_header: bool) -> Result<Rows, String> {
        // WHY: Preserve deterministic failures keyed by job for host telemetry.
        let decoded = decode_input(&job_id, &input)?;
        parse_csv(&job_id, &decoded, has_header)
    }
}

bindings::export!(Component with_types_in bindings);

// WHY: Normalize CSV source across plain strings and data URIs.
fn decode_input(job_id: &str, raw: &str) -> Result<String, String> {
    if let Some(rest) = raw.strip_prefix("data:") {
        return decode_data_uri(job_id, rest);
    }
    Ok(trim_bom(raw))
}

// INVARIANT: Successful result never contains a UTF-8 BOM prefix.
fn trim_bom(source: &str) -> String {
    const BOM: char = '\u{FEFF}';
    if source.starts_with(BOM) {
        source.trim_start_matches(BOM).to_string()
    } else {
        source.to_string()
    }
}

fn decode_data_uri(job_id: &str, rest: &str) -> Result<String, String> {
    let comma = rest.find(',').ok_or_else(|| {
        format!("{ERROR_DATA_URI}: job {job_id}: data URI missing comma separator")
    })?;
    let (meta, payload) = rest.split_at(comma);
    let body = &payload[1..];
    let lower_meta = meta.to_ascii_lowercase();
    if lower_meta.contains(";base64") {
        BASE64_ENGINE
            .decode(body.trim())
            .map_err(|err| format!("{ERROR_DATA_URI}: job {job_id}: base64 decode failed: {err}"))
            .and_then(|bytes| {
                String::from_utf8(bytes).map(trim_bom).map_err(|err| {
                    format!("{ERROR_UTF8}: job {job_id}: base64 bytes not utf-8: {err}")
                })
            })
    } else {
        percent_decode_str(body)
            .decode_utf8()
            .map(|cow| trim_bom(cow.as_ref()))
            .map_err(|err| format!("{ERROR_UTF8}: job {job_id}: percent-decoding failed: {err}"))
    }
}

// WHY: csv crate enforces RFC 4180 rules and surfaces granular errors.
// INVARIANT: Returned rows retain original ordering; header row is preserved when requested.
fn parse_csv(job_id: &str, csv_text: &str, has_header: bool) -> Result<Rows, String> {
    let mut reader = ReaderBuilder::new()
        .has_headers(has_header)
        .flexible(true)
        .trim(Trim::None)
        .from_reader(csv_text.as_bytes());

    let mut rows: Rows = Vec::new();
    if has_header {
        let headers = reader.headers().map_err(|err| {
            format!("{ERROR_CSV}: job {job_id}: failed to read header row: {err}")
        })?;
        rows.push(headers.iter().map(|cell| cell.to_string()).collect());
    }

    for record in reader.records() {
        let rec =
            record.map_err(|err| format!("{ERROR_CSV}: job {job_id}: row parse failed: {err}"))?;
        rows.push(rec.iter().map(|cell| cell.to_string()).collect());
    }

    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_csv_with_header() {
        let content = "name,qty\nalpha,1\nbravo,2\n";
        let rows = parse_csv("job-test", content, true).expect("csv rows");
        assert_eq!(
            rows,
            vec![
                vec!["name".to_string(), "qty".to_string()],
                vec!["alpha".to_string(), "1".to_string()],
                vec!["bravo".to_string(), "2".to_string()]
            ]
        );
    }

    #[test]
    fn parses_plain_csv_without_header() {
        let content = "alpha,1\nbravo,2\n";
        let rows = parse_csv("job-test", content, false).expect("csv rows");
        assert_eq!(
            rows,
            vec![
                vec!["alpha".to_string(), "1".to_string()],
                vec!["bravo".to_string(), "2".to_string()]
            ]
        );
    }

    #[test]
    fn decodes_base64_data_uri() {
        let data = BASE64_ENGINE.encode("name,qty\nalpha,1\n");
        let uri = format!("data:text/csv;base64,{data}");
        let decoded = decode_input("job-b64", &uri).expect("data uri");
        assert_eq!(decoded, "name,qty\nalpha,1\n");
    }

    #[test]
    fn decodes_percent_encoded_data_uri() {
        let uri = "data:text/csv,name%2Cqty%0Aalpha%2C1%0A";
        let decoded = decode_input("job-pct", uri).expect("data uri");
        assert_eq!(decoded, "name,qty\nalpha,1\n");
    }

    #[test]
    fn rejects_broken_data_uri() {
        let err = decode_input("job-err", "data:text/csv;base64").unwrap_err();
        assert!(err.contains(ERROR_DATA_URI));
    }
}
