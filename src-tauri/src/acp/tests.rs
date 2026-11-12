use super::*;

fn thought(line: &str) -> String {
    match parse_acp_stream_line("thread-1", "run-1", line).expect("frame") {
        AcpStreamEvent::ThoughtDelta { text, .. } => text,
        other => panic!("expected a thought, got {other:?}"),
    }
}

#[test]
fn provider_thought_frames_keep_their_text() {
    assert_eq!(
        thought(r#"{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Look at the tests."}}"#),
        "Look at the tests."
    );
    assert_eq!(
        thought(r#"{"type":"item.completed","item":{"type":"reasoning","text":"Checked the diff."}}"#),
        "Checked the diff."
    );
    assert_eq!(
        thought(r#"{"type":"text","part":{"type":"reasoning","text":"Planning the edit."}}"#),
        "Planning the edit."
    );
    assert_eq!(
        thought(r#"{"type":"response.reasoning_text.delta","delta":"Tracing the call."}"#),
        "Tracing the call."
    );
    assert_eq!(
        thought(r#"{"type":"thinking","thinking":"Reading the file."}"#),
        "Reading the file."
    );
    assert_eq!(
        thought(r#"{"type":"thought","text":"Searching the repo."}"#),
        "Searching the repo."
    );
    assert_eq!(
        thought(r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Opening the editor."}]}}"#),
        "Opening the editor."
    );
}

#[test]
fn an_unreadable_thought_frame_stays_a_notice() {
    match parse_acp_stream_line(
        "thread-1",
        "run-1",
        r#"{"type":"reasoning","encrypted_content":"abc"}"#,
    )
    .expect("frame")
    {
        AcpStreamEvent::UnknownFrame { message } => {
            assert!(message.contains("reasoning"));
        }
        other => panic!("expected a notice, got {other:?}"),
    }
}

#[test]
fn read_file_keeps_a_capitalized_path() {
    let params = serde_json::json!({
        "Description": "Read file",
        "EndLine": 50,
        "Path": "C:/tmp/mcp/engram/mem_current_project.json",
        "StartLine": 1
    });
    let (_kind, _server, title, command, file_path, _, _) =
        classify_tool_metadata("read_file", &params);
    assert!(command.is_none());
    assert_eq!(
        file_path.as_deref(),
        Some("C:/tmp/mcp/engram/mem_current_project.json")
    );
    assert!(title.contains("mem_current_project.json"), "{title}");
}

#[test]
fn test_antigravity_list_google_accounts() {
    let res = antigravity_list_google_accounts().unwrap();
    println!("LIST GOOGLE ACCOUNTS: {}", serde_json::to_string_pretty(&res).unwrap());
    assert!(res.get("active").and_then(|v| v.as_str()).is_some(), "Expected active account to be present");
    let arr = res.get("accounts").and_then(|v| v.as_array()).unwrap();
    assert!(!arr.is_empty(), "Expected accounts array not to be empty");
}
