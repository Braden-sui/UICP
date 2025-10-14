//! table.query@0.1.0 component entrypoint.
//! WHY: Keep host coordination contained for maintainable bindings upgrades.

#![allow(clippy::missing_errors_doc)]

#[allow(warnings)]
mod bindings;

use bindings::export;
use bindings::exports::uicp::task_table_query::table::{Error, Guest, Input, Output};
use bindings::uicp::host::control;
use bindings::wasi::clocks::monotonic_clock;
use bindings::wasi::io::streams::OutputStream;
use ciborium::ser::into_writer;
use ciborium::value::{Integer, Value};

const PARTIAL_KIND_PROGRESS: u8 = 0;
const PARTIAL_KIND_TOTAL: u8 = 2;

type FilterSpec = (usize, String);

struct Component;

impl Guest for Component {
    fn run(job_id: String, input: Input) -> Result<Output, Error> {
        run_table_query(job_id, input)
    }
}

export!(Component);

// WHY: Separate orchestration from trait impl for easier unit testing.
fn run_table_query(job_id: String, input: Input) -> Result<Output, Error> {
    let Input {
        rows,
        select,
        where_contains,
    } = input;

    let select_indices: Vec<usize> = select.into_iter().map(|idx| idx as usize).collect();
    let filter = where_contains.map(|f| (f.col as usize, f.needle));

    let mut sink = control::open_partial_sink(&job_id);
    let mut seq = 0u32;

    let filtered_rows = filter_rows(rows, filter.as_ref());
    let mut projected: Output = Vec::with_capacity(filtered_rows.len());
    for (idx, row) in filtered_rows.into_iter().enumerate() {
        let cells = project_row(&row, &select_indices);
        projected.push(cells);

        if idx % 100 == 0 {
            emit_progress(&mut sink, &job_id, &mut seq, idx as u64);
        }

        if should_cancel(&job_id) {
            return Err(Error::Cancelled);
        }
    }

    emit_total(&mut sink, &job_id, &mut seq, projected.len() as u64);

    Ok(projected)
}

// WHY: Host cancellation may be cooperative (user) or deadline-driven.
fn should_cancel(job_id: &str) -> bool {
    control::should_cancel(job_id) || control::remaining_ms(job_id) == 0
}

// WHY: Split selection so filter + projection logic stays pure for tests.
fn filter_rows(rows: Vec<Vec<String>>, filter: Option<&FilterSpec>) -> Vec<Vec<String>> {
    match filter {
        Some((col, needle)) => rows
            .into_iter()
            .filter(|row| {
                row.get(*col)
                    .map(|cell| cell.contains(needle))
                    .unwrap_or(false)
            })
            .collect(),
        None => rows,
    }
}

// INVARIANT: Returned projection maintains selection order; missing cells become "".
fn project_row(row: &[String], select: &[usize]) -> Vec<String> {
    let mut out = Vec::with_capacity(select.len());
    for &idx in select {
        out.push(row.get(idx).cloned().unwrap_or_default());
    }
    out
}

fn emit_progress(sink: &mut OutputStream, job_id: &str, seq: &mut u32, processed: u64) {
    let timestamp = now_microseconds();
    let payload = Value::Map(vec![(
        Value::Text("processed".into()),
        Value::Integer(Integer::from(processed)),
    )]);
    emit_partial(
        sink,
        seq,
        PARTIAL_KIND_PROGRESS,
        timestamp,
        Some(payload),
        job_id,
    );
}

fn emit_total(sink: &mut OutputStream, job_id: &str, seq: &mut u32, total: u64) {
    let timestamp = now_microseconds();
    let payload = Value::Map(vec![(
        Value::Text("total".into()),
        Value::Integer(Integer::from(total)),
    )]);
    emit_partial(
        sink,
        seq,
        PARTIAL_KIND_TOTAL,
        timestamp,
        Some(payload),
        job_id,
    );
}

fn now_microseconds() -> u64 {
    monotonic_clock::now() / 1_000_000
}

fn emit_partial(
    sink: &mut OutputStream,
    seq: &mut u32,
    kind: u8,
    timestamp: u64,
    payload: Option<Value>,
    job_id: &str,
) {
    let frame = cbor_envelope(kind, bump_seq(seq), timestamp, payload);
    // WHY: Blocking write ensures ordering; treat failures as fatal traps to obey fail-loud.
    if let Err(err) = sink.blocking_write_and_flush(&frame) {
        panic!("E-UICP-801: job {job_id}: partial emission failed: {err:?}");
    }
}

fn bump_seq(seq: &mut u32) -> u32 {
    let next = seq.wrapping_add(1);
    *seq = next;
    next
}

fn cbor_envelope(kind: u8, seq: u32, timestamp: u64, payload: Option<Value>) -> Vec<u8> {
    let mut entries: Vec<(Value, Value)> = vec![
        (
            Value::Integer(Integer::from(1u8)),
            Value::Integer(Integer::from(kind)),
        ),
        (
            Value::Integer(Integer::from(2u32)),
            Value::Integer(Integer::from(seq)),
        ),
        (
            Value::Integer(Integer::from(3u64)),
            Value::Integer(Integer::from(timestamp)),
        ),
    ];
    if let Some(p) = payload {
        entries.push((Value::Integer(Integer::from(4u8)), p));
    }
    let map = Value::Map(entries);
    let mut out = Vec::new();
    let _ = into_writer(&map, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_rows_applies_contains() {
        let rows = vec![
            vec!["header".into(), "city".into()],
            vec!["alice".into(), "austin".into()],
            vec!["bob".into(), "boston".into()],
            vec!["carol".into(), "chicago".into()],
        ];
        let filter = (1usize, "bo".to_string());
        let filtered = filter_rows(rows, Some(&filter));
        assert_eq!(filtered, vec![vec!["bob".into(), "boston".into()]]);
    }

    #[test]
    fn project_row_respects_selection() {
        let row = vec!["name".into(), "city".into(), "zip".into()];
        let projected = project_row(&row, &[0, 2, 5]);
        assert_eq!(projected, vec!["name".into(), "zip".into(), "".into()]);
    }
}
