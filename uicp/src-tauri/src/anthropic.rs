use serde_json::{json, Value};

pub fn normalize_message(input: Value) -> Option<Value> {
    let event_type = input.get("type")?.as_str()?;
    match event_type {
        "content_block_delta" => normalize_content_block_delta(&input),
        "content_block_start" => normalize_content_block_start(&input),
        "message_stop" => Some(json!({ "done": true })),
        _ => None,
    }
}

fn normalize_content_block_delta(input: &Value) -> Option<Value> {
    let delta = input.get("delta")?.as_object()?;
    let index = input
        .get("index")
        .and_then(|v| v.as_u64())
        .map(|v| v as i64)
        .unwrap_or(0);
    match delta.get("type")?.as_str()? {
        "text_delta" => {
            let text = delta.get("text")?.as_str()?.to_string();
            if text.is_empty() {
                return None;
            }
            Some(json!({
                "choices": [{
                    "delta": {
                        "content": [{
                            "type": "text",
                            "text": text,
                        }]
                    }
                }]
            }))
        }
        "tool_use_delta" => {
            let partial = delta.get("partial_json")?.as_str()?.to_string();
            if partial.is_empty() {
                return None;
            }
            Some(json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "index": index,
                            "function": {
                                "arguments": partial,
                            }
                        }]
                    }
                }]
            }))
        }
        _ => None,
    }
}

fn normalize_content_block_start(input: &Value) -> Option<Value> {
    let content_block = input.get("content_block")?.as_object()?;
    match content_block.get("type")?.as_str()? {
        "tool_use" => {
            let index = input
                .get("index")
                .and_then(|v| v.as_u64())
                .map(|v| v as i64)
                .unwrap_or(0);
            let name = content_block.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let id = content_block.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let input_payload = content_block
                .get("input")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let arguments = serde_json::to_string(&input_payload).unwrap_or_else(|_| "{}".to_string());
            Some(json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "index": index,
                            "id": if id.is_empty() { Value::Null } else { Value::String(id.to_string()) },
                            "name": if name.is_empty() { Value::Null } else { Value::String(name.to_string()) },
                            "function": {
                                "name": name,
                                "arguments": arguments,
                            }
                        }]
                    }
                }]
            }))
        }
        _ => None,
    }
}
