use ever_works_windows_job_launcher::protocol::{
    ClientMessage, Completion, CompletionStatus, FailureStage, FrameDecoder, LaunchRequest,
    ProtocolError, ServerFrameDecoder, ServerMessage, TestFailure, encode_client_message,
    encode_environment_block, encode_server_message, quote_windows_argument,
};

fn minimal_request() -> LaunchRequest {
    LaunchRequest {
        application_path: r"C:\a.exe".to_owned(),
        working_directory: r"C:\w".to_owned(),
        arguments: vec!["x".to_owned()],
        environment: vec![("A".to_owned(), "B".to_owned())],
        timeout_ms: 1,
        cleanup_timeout_ms: 2,
        max_output_bytes: 3,
        test_failure: TestFailure::None,
    }
}

#[test]
fn launch_frame_matches_the_v1_golden_vector() {
    let encoded = encode_client_message(&ClientMessage::Launch(minimal_request())).unwrap();
    let expected = concat!(
        "45574a4c010001003c000000",
        "08000000433a5c612e657865",
        "04000000433a5c77",
        "010000000100000078",
        "0100000001000000410100000042",
        "0100000002000000030000000000000000"
    );

    assert_eq!(hex(&encoded), expected);
}

#[test]
fn decoder_preserves_fragmented_unicode_arguments_without_shell_reparsing() {
    let request = LaunchRequest {
        application_path: r"C:\工具\runner.exe".to_owned(),
        working_directory: r"C:\งาน".to_owned(),
        arguments: vec![
            "two words".to_owned(),
            "quote\"and\\slash".to_owned(),
            "🦀".to_owned(),
        ],
        environment: vec![("FAKE_TOKEN".to_owned(), "not-a-credential-λ".to_owned())],
        timeout_ms: 30_000,
        cleanup_timeout_ms: 5_000,
        max_output_bytes: 1_048_576,
        test_failure: TestFailure::None,
    };
    let encoded = encode_client_message(&ClientMessage::Launch(request.clone())).unwrap();
    let mut decoder = FrameDecoder::default();
    let mut decoded = Vec::new();
    for byte in encoded {
        decoded.extend(decoder.push(&[byte]).unwrap());
    }

    assert_eq!(decoded, vec![ClientMessage::Launch(request)]);
}

#[test]
fn encoder_rejects_nul_and_invalid_environment_names() {
    for (name, mutate) in [
        ("application", 0_u8),
        ("working directory", 1),
        ("argument", 2),
        ("environment value", 3),
    ] {
        let mut request = minimal_request();
        match mutate {
            0 => request.application_path.push('\0'),
            1 => request.working_directory.push('\0'),
            2 => request.arguments[0].push('\0'),
            3 => request.environment[0].1.push('\0'),
            _ => unreachable!(),
        }
        assert_eq!(
            encode_client_message(&ClientMessage::Launch(request)),
            Err(ProtocolError::InvalidField),
            "{name}"
        );
    }

    let mut request = minimal_request();
    request.environment[0].0 = "BAD=NAME".to_owned();
    assert_eq!(
        encode_client_message(&ClientMessage::Launch(request)),
        Err(ProtocolError::InvalidField)
    );
}

#[test]
fn decoder_rejects_oversized_and_unknown_frames_before_allocating_payloads() {
    let mut oversized = Vec::from(*b"EWJL");
    oversized.extend_from_slice(&1_u16.to_le_bytes());
    oversized.extend_from_slice(&1_u16.to_le_bytes());
    oversized.extend_from_slice(&(1_048_577_u32).to_le_bytes());
    let mut decoder = FrameDecoder::default();
    assert_eq!(decoder.push(&oversized), Err(ProtocolError::FrameTooLarge));

    let mut unknown = Vec::from(*b"EWJL");
    unknown.extend_from_slice(&1_u16.to_le_bytes());
    unknown.extend_from_slice(&99_u16.to_le_bytes());
    unknown.extend_from_slice(&0_u32.to_le_bytes());
    let mut decoder = FrameDecoder::default();
    assert_eq!(decoder.push(&unknown), Err(ProtocolError::UnknownMessage));
}

#[test]
fn decoder_exposes_a_truncated_frame_at_control_eof() {
    let encoded = encode_client_message(&ClientMessage::Launch(minimal_request())).unwrap();
    let mut decoder = FrameDecoder::default();
    assert!(
        decoder
            .push(&encoded[..encoded.len() - 1])
            .unwrap()
            .is_empty()
    );
    assert!(decoder.has_pending_bytes());
    assert_eq!(
        decoder.push(&encoded[encoded.len() - 1..]).unwrap().len(),
        1
    );
    assert!(!decoder.has_pending_bytes());
}

#[test]
fn windows_quoting_and_environment_block_cover_backslash_quote_boundaries() {
    assert_eq!(quote_windows_argument(""), r#""""#);
    assert_eq!(quote_windows_argument("plain"), r#""plain""#);
    assert_eq!(quote_windows_argument("two words"), r#""two words""#);
    assert_eq!(quote_windows_argument(r#"a\"b"#), r#""a\\\"b""#);
    assert_eq!(quote_windows_argument(r"trailing\"), r#""trailing\\""#);

    let block = encode_environment_block(&[
        ("b".to_owned(), "two".to_owned()),
        ("A".to_owned(), "one".to_owned()),
    ])
    .unwrap();
    let expected: Vec<u16> = "A=one\0b=two\0\0".encode_utf16().collect();
    assert_eq!(block, expected);
}

#[test]
fn server_frames_round_trip_launched_output_and_verified_completion() {
    let messages = vec![
        ServerMessage::Launched { root_pid: 42 },
        ServerMessage::Stdout("hello λ".as_bytes().to_vec()),
        ServerMessage::Stderr(vec![0, 1, 2, 255]),
        ServerMessage::Completed(Completion {
            status: CompletionStatus::Exited,
            exit_code: Some(7),
            root_pid: 42,
            termination_verified: true,
            active_processes: 0,
            process_ids: Vec::new(),
            failure_stage: FailureStage::None,
            os_error: 0,
        }),
    ];
    let encoded: Vec<u8> = messages
        .iter()
        .flat_map(|message| encode_server_message(message).unwrap())
        .collect();
    let mut decoder = ServerFrameDecoder::default();
    let mut decoded = Vec::new();
    for chunk in encoded.chunks(3) {
        decoded.extend(decoder.push(chunk).unwrap());
    }
    assert_eq!(decoded, messages);
}

#[test]
fn launched_frame_matches_the_cross_language_golden_vector() {
    let encoded = encode_server_message(&ServerMessage::Launched { root_pid: 42 }).unwrap();
    assert_eq!(hex(&encoded), "45574a4c01000180040000002a000000");
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
