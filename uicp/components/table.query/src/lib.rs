// Generate bindings with wit-bindgen (WASI Preview 2) and explicit package mapping
wit_bindgen::generate!({ path: "wit", world: "entry" });

use exports::uicp::task_table_query::task::{Error, Guest, Input};
use imports::uicp::host::control;
use imports::wasi::clocks::monotonic_clock;
use imports::wasi::io::streams::OutputStream;
use ciborium::value::{Integer, Value};

struct Component;

impl Guest for Component {
  fn run(
    job: String,
    input: Input,
  ) -> Result<Vec<Vec<String>>, Error> {
    let rows = input.rows;
    let select = input.select;
    let where_opt = input.where_contains;

    let sink: OutputStream = control::open_partial_sink(&job);
    let mut seq: u32 = 0;

    // Optional filter: contains needle in column `col`
    let filtered = if let Some(cond) = where_opt {
      let (col, needle) = (cond.col as usize, cond.needle);
      rows.into_iter()
        .filter(|r| r.get(col).map(|c| c.contains(&needle)).unwrap_or(false))
        .collect::<Vec<_>>()
    } else {
      rows
    };

    // Project selected columns (by index), and stream progress
    let mut out: Vec<Vec<String>> = Vec::with_capacity(filtered.len());
    for (idx, r) in filtered.into_iter().enumerate() {
      let mut proj: Vec<String> = Vec::with_capacity(select.len());
      for &i in select.iter() {
        let x = i as usize;
        proj.push(r.get(x).cloned().unwrap_or_default());
      }
      out.push(proj);

      if idx % 100 == 0 {
        let ts = (monotonic_clock::now() / 1_000_000) as u64;
        let payload = Value::Map(vec![(Value::Text("processed".into()), Value::Integer(Integer::from(idx as u64)))]);
        let frame = cbor_envelope(0, { seq = seq.wrapping_add(1); seq }, ts, Some(payload));
        let _ = sink.blocking_write_and_flush(&frame);
      }

      if control::should_cancel(&job) || control::remaining_ms(&job) == 0 {
        return Err(Error::Cancelled);
      }
    }

    let ts = (monotonic_clock::now() / 1_000_000) as u64;
    let payload = Value::Map(vec![(Value::Text("total".into()), Value::Integer(Integer::from(out.len() as u64)))]);
    let frame = cbor_envelope(2, { seq = seq.wrapping_add(1); seq }, ts, Some(payload));
    let _ = sink.blocking_write_and_flush(&frame);

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
  if let Some(p) = payload { entries.push((Value::Integer(Integer::from(4u8)), p)); }
  let map = Value::Map(entries);
  let mut out = Vec::new();
  let _ = ciborium::ser::into_writer(&map, &mut out);
  out
}

