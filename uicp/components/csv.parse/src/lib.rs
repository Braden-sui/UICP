#[allow(warnings)]
mod bindings;

use bindings::export;
use bindings::exports;
use bindings::exports::uicp::task_csv_parse::task::{Error, Guest, Input};
use bindings::uicp::host::control;
use bindings::wasi::clocks::monotonic_clock;
use bindings::wasi::io::streams::OutputStream;
use ciborium::value::{Integer, Value};
use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine as _;

struct Component;

impl Guest for Component {
    fn run(job: String, input: Input) -> Result<Vec<Vec<String>>, Error> {
        let source = input.source;
        let has_header = input.has_header;
        let csv_data = match parse_data_uri(&source) {
            Some(bytes) => bytes,
            None => return Err(Error::InvalidInput),
        };
        let mut rdr = csv::ReaderBuilder::new()
            .has_headers(has_header)
            .from_reader(csv_data.as_slice());
        let mut out: Vec<Vec<String>> = Vec::new();

        // partial streaming: open sink and emit periodic progress
        let mut seq: u32 = 0;
        let sink: OutputStream = control::open_partial_sink(&job);

        for rec in rdr.records() {
            match rec {
                Ok(r) => {
                    out.push(r.iter().map(|s| s.to_string()).collect());
                    if out.len() % 50 == 0 {
                        let ts = (monotonic_clock::now() / 1_000_000) as u64;
                        let payload = Value::Map(vec![
                            (Value::Text("done".into()),
                             Value::Integer(Integer::from(out.len() as u64)))
                        ]);
                        let frame = cbor_envelope(0, { seq = seq.wrapping_add(1); seq }, ts, Some(payload));
                        if let Err(_e) = sink.blocking_write_and_flush(&frame) {
                            return Err(Error::CsvError);
                        }
                    }
                }
                Err(_e) => return Err(Error::CsvError),
            }
            if control::should_cancel(&job) || control::remaining_ms(&job) == 0 {
                return Err(Error::Cancelled);
            }
        }

        // final metric chunk (optional)
        let ts = (monotonic_clock::now() / 1_000_000) as u64;
        let payload = Value::Map(vec![
            (Value::Text("total".into()),
             Value::Integer(Integer::from(out.len() as u64)))
        ]);
        let frame = cbor_envelope(2, { seq = seq.wrapping_add(1); seq }, ts, Some(payload));
        if let Err(_e) = sink.blocking_write_and_flush(&frame) {
            return Err(Error::CsvError);
        }

        Ok(out)
    }
}

export!(Component);

fn cbor_envelope(t: u8, s: u32, ts: u64, payload: Option<Value>) -> Vec<u8> {
    let mut entries: Vec<(Value, Value)> = vec![
        (Value::Integer(Integer::from(1u8)), Value::Integer(Integer::from(t))),
        (Value::Integer(Integer::from(2u32)), Value::Integer(Integer::from(s))),
        (Value::Integer(Integer::from(3u64)), Value::Integer(Integer::from(ts))),
    ];
    if let Some(p) = payload {
        entries.push((Value::Integer(Integer::from(4u8)), p));
    }
    let map = Value::Map(entries);
    let mut out = Vec::new();
    let _ = ciborium::ser::into_writer(&map, &mut out);
    out
}

fn parse_data_uri(s: &str) -> Option<Vec<u8>> {
    if !s.starts_with("data:") {
        return None;
    }
    // Expect "data:text/csv;base64,<payload>" or "data:text/csv,<payload>"
    let (_, rest) = s.split_once(',')?;
    if s.contains(";base64,") {
        BASE64_ENGINE.decode(rest).ok()
    } else {
        percent_decode(rest)
    }
}

fn percent_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = (hex_val(bytes[i + 1])? << 4) | hex_val(bytes[i + 2])?;
            out.push(h);
            i += 3;
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Some(out)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(10 + (b - b'a')),
        b'A'..=b'F' => Some(10 + (b - b'A')),
        _ => None,
    }
}
