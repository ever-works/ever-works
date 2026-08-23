#![cfg(all(windows, feature = "test-fixtures"))]

use std::{
    collections::VecDeque,
    fs,
    io::{Read, Write},
    os::windows::{io::AsRawHandle, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use ever_works_windows_job_launcher::protocol::{
    ClientMessage, Completion, CompletionStatus, LaunchRequest, ServerFrameDecoder, ServerMessage,
    TestFailure, encode_client_message,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, WAIT_OBJECT_0},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_UILIMIT_HANDLES,
            JOBOBJECT_BASIC_UI_RESTRICTIONS, JobObjectBasicUIRestrictions, SetInformationJobObject,
            TerminateJobObject,
        },
        Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    },
};

const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const DETACHED_PROCESS: u32 = 0x0000_0008;

#[test]
fn fixture_exits_after_writing_both_streams() {
    if fixture_mode() != Some("exit") {
        return;
    }
    print!("stdout-λ");
    eprint!("stderr-งาน");
}

#[test]
fn fixture_waits_after_writing_its_pid() {
    if fixture_mode() != Some("wait") {
        return;
    }
    write_pid_marker();
    thread::sleep(Duration::from_secs(60));
}

#[test]
fn fixture_floods_stdout() {
    if fixture_mode() != Some("flood") {
        return;
    }
    let mut stdout = std::io::stdout().lock();
    for _ in 0..128 {
        stdout.write_all(&[b'x'; 16 * 1024]).unwrap();
    }
    stdout.flush().unwrap();
    thread::sleep(Duration::from_secs(60));
}

#[test]
fn fixture_echoes_stdin() {
    if fixture_mode() != Some("echo") {
        return;
    }
    let mut bytes = Vec::new();
    std::io::stdin().read_to_end(&mut bytes).unwrap();
    std::io::stdout().write_all(&bytes).unwrap();
}

#[test]
fn fixture_spawns_a_detached_process_group() {
    if fixture_mode() != Some("spawn-detached") {
        return;
    }
    let marker = marker_path();
    let current_exe = std::env::current_exe().unwrap();
    let mut child = Command::new(current_exe)
        .args([
            "--exact",
            "fixture_detached_descendant_waits",
            "--nocapture",
        ])
        .env_clear()
        .env("EWJL_FIXTURE_MODE", "detached-wait")
        .env("EWJL_FIXTURE_MARKER", &marker)
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .unwrap();
    wait_for_marker(&marker, Duration::from_secs(5));
    let _ = child.try_wait();
}

#[test]
fn fixture_detached_descendant_waits() {
    if fixture_mode() != Some("detached-wait") {
        return;
    }
    write_pid_marker();
    thread::sleep(Duration::from_secs(60));
}

#[test]
fn fixture_runs_helper_from_an_outer_job_after_gate() {
    if fixture_mode() != Some("nested-wrapper") {
        return;
    }
    let gate = PathBuf::from(std::env::var_os("EWJL_FIXTURE_GATE").unwrap());
    let result = PathBuf::from(std::env::var_os("EWJL_FIXTURE_RESULT").unwrap());
    let entry_marker = marker_path();
    wait_for_marker(&gate, Duration::from_secs(10));
    let mut helper = spawn_helper();
    send_launch(
        &mut helper,
        request_with_marker(
            "wait",
            "fixture_waits_after_writing_its_pid",
            350,
            1_048_576,
            TestFailure::None,
            &entry_marker,
        ),
    );
    let messages = read_to_completion(&mut helper, Duration::from_secs(10));
    let value = completion(&messages);
    fs::write(
        result,
        format!(
            "{:?}|{:?}|{}|{}|{}",
            value.status,
            value.failure_stage,
            value.termination_verified,
            value.active_processes,
            value.process_ids.len()
        ),
    )
    .unwrap();
    let _ = helper.wait();
}

#[test]
fn reports_streams_and_completion_only_after_the_real_job_is_verified_empty() {
    let mut helper = spawn_helper();
    send_launch(
        &mut helper,
        request(
            "exit",
            "fixture_exits_after_writing_both_streams",
            10_000,
            1_048_576,
            TestFailure::None,
        ),
    );
    let messages = read_to_completion(&mut helper, Duration::from_secs(15));

    assert!(
        matches!(messages.first(), Some(ServerMessage::Launched { root_pid }) if *root_pid > 0)
    );
    assert!(contains_bytes(
        &collect_stream(&messages, true),
        "stdout-λ".as_bytes()
    ));
    assert!(contains_bytes(
        &collect_stream(&messages, false),
        "stderr-งาน".as_bytes()
    ));
    let completion = completion(&messages);
    assert_eq!(completion.status, CompletionStatus::Exited);
    assert!(completion.termination_verified);
    assert_eq!(completion.active_processes, 0);
    assert!(completion.process_ids.is_empty());
    assert_eq!(helper.wait().unwrap().code(), Some(0));
}

#[test]
fn cancellation_kills_the_root_and_reports_verified_zero_membership() {
    let marker = unique_marker("cancel");
    let mut helper = spawn_helper();
    send_launch(
        &mut helper,
        request_with_marker(
            "wait",
            "fixture_waits_after_writing_its_pid",
            30_000,
            1_048_576,
            TestFailure::None,
            &marker,
        ),
    );
    let mut reader = MessageReader::new(helper.stdout.take().unwrap());
    assert!(matches!(
        reader.next(Duration::from_secs(10)),
        ServerMessage::Launched { .. }
    ));
    wait_for_marker(&marker, Duration::from_secs(5));
    helper
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&encode_client_message(&ClientMessage::Cancel).unwrap())
        .unwrap();
    let messages = reader.read_completion(Duration::from_secs(10));
    let completion = completion(&messages);
    assert_eq!(completion.status, CompletionStatus::Cancelled);
    assert!(completion.termination_verified);
    assert_eq!(completion.active_processes, 0);
    assert!(completion.process_ids.is_empty());
    assert_eq!(helper.wait().unwrap().code(), Some(0));
    let _ = fs::remove_file(marker);
}

#[test]
fn cancellation_racing_root_exit_never_reports_an_unverified_success() {
    for _ in 0..8 {
        let mut helper = spawn_helper();
        send_launch(
            &mut helper,
            request(
                "exit",
                "fixture_exits_after_writing_both_streams",
                10_000,
                1_048_576,
                TestFailure::None,
            ),
        );
        let mut reader = MessageReader::new(helper.stdout.take().unwrap());
        assert!(matches!(
            reader.next(Duration::from_secs(10)),
            ServerMessage::Launched { .. }
        ));
        let _ = helper
            .stdin
            .as_mut()
            .unwrap()
            .write_all(&encode_client_message(&ClientMessage::Cancel).unwrap());
        let messages = reader.read_completion(Duration::from_secs(10));
        let value = completion(&messages);
        assert!(matches!(
            value.status,
            CompletionStatus::Exited | CompletionStatus::Cancelled
        ));
        assert!(value.termination_verified);
        assert_eq!(value.active_processes, 0);
        assert!(value.process_ids.is_empty());
        let _ = helper.wait();
    }
}

#[test]
fn forwards_framed_unicode_stdin_and_close_without_a_shell() {
    let mut helper = spawn_helper();
    send_launch(
        &mut helper,
        request(
            "echo",
            "fixture_echoes_stdin",
            10_000,
            1_048_576,
            TestFailure::None,
        ),
    );
    let mut reader = MessageReader::new(helper.stdout.take().unwrap());
    assert!(matches!(
        reader.next(Duration::from_secs(10)),
        ServerMessage::Launched { .. }
    ));
    helper
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&encode_client_message(&ClientMessage::Stdin(BufferFixture::first())).unwrap())
        .unwrap();
    helper
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&encode_client_message(&ClientMessage::Stdin(BufferFixture::second())).unwrap())
        .unwrap();
    helper
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&encode_client_message(&ClientMessage::CloseStdin).unwrap())
        .unwrap();

    let messages = reader.read_completion(Duration::from_secs(10));
    assert!(contains_bytes(
        &collect_stream(&messages, true),
        &[BufferFixture::first(), BufferFixture::second()].concat()
    ));
    let value = completion(&messages);
    assert_eq!(value.status, CompletionStatus::Exited);
    assert!(value.termination_verified);
    assert_eq!(helper.wait().unwrap().code(), Some(0));
}

#[test]
fn detached_new_process_group_descendants_remain_in_the_job_and_are_killed_on_timeout() {
    let marker = unique_marker("detached");
    let mut helper = spawn_helper();
    send_launch(
        &mut helper,
        request_with_marker(
            "spawn-detached",
            "fixture_spawns_a_detached_process_group",
            350,
            1_048_576,
            TestFailure::None,
            &marker,
        ),
    );
    let messages = read_to_completion(&mut helper, Duration::from_secs(10));
    let completion = completion(&messages);
    assert_eq!(completion.status, CompletionStatus::TimedOut);
    assert!(completion.termination_verified);
    assert_eq!(completion.active_processes, 0);
    assert!(completion.process_ids.is_empty());
    assert_eq!(helper.wait().unwrap().code(), Some(0));
    let _ = fs::remove_file(marker);
}

#[test]
fn output_limit_and_transport_backpressure_fail_closed() {
    let mut helper = spawn_helper();
    send_launch(
        &mut helper,
        request(
            "flood",
            "fixture_floods_stdout",
            30_000,
            32_768,
            TestFailure::None,
        ),
    );
    let messages = read_to_completion(&mut helper, Duration::from_secs(10));
    let completion = completion(&messages);
    assert_eq!(completion.status, CompletionStatus::OutputLimit);
    assert!(completion.termination_verified);
    assert!(collect_stream(&messages, true).len() <= 32_768);
    assert_eq!(helper.wait().unwrap().code(), Some(0));
}

#[test]
fn parent_control_eof_closes_the_only_job_handle_and_kills_the_child() {
    let marker = unique_marker("eof");
    let mut helper = spawn_helper();
    send_launch(
        &mut helper,
        request_with_marker(
            "wait",
            "fixture_waits_after_writing_its_pid",
            30_000,
            1_048_576,
            TestFailure::None,
            &marker,
        ),
    );
    let mut reader = MessageReader::new(helper.stdout.take().unwrap());
    assert!(matches!(
        reader.next(Duration::from_secs(10)),
        ServerMessage::Launched { .. }
    ));
    wait_for_marker(&marker, Duration::from_secs(5));
    drop(helper.stdin.take());
    assert!(helper.wait_timeout(Duration::from_secs(10)).is_some());
    let _ = fs::remove_file(marker);
}

#[test]
fn helper_crash_after_resume_closes_its_exclusive_job_handle() {
    let marker = unique_marker("helper-crash");
    let mut helper = spawn_helper();
    send_launch(
        &mut helper,
        request_with_marker(
            "wait",
            "fixture_waits_after_writing_its_pid",
            30_000,
            1_048_576,
            TestFailure::AfterResumeAbort,
            &marker,
        ),
    );
    let mut reader = MessageReader::new(helper.stdout.take().unwrap());
    let root_pid = match reader.next(Duration::from_secs(10)) {
        ServerMessage::Launched { root_pid } => root_pid,
        message => panic!("expected launched frame, got {message:?}"),
    };
    let status = helper
        .wait_timeout(Duration::from_secs(10))
        .expect("helper did not abort");
    assert!(!status.success());
    assert_process_exited(root_pid, Duration::from_secs(5));
    let _ = fs::remove_file(marker);
}

#[test]
fn nested_outer_job_is_either_rejected_before_entry_or_finishes_with_verified_containment() {
    let gate = unique_marker("nested-gate");
    let result = unique_marker("nested-result");
    let entry = unique_marker("nested-entry");
    let current_exe = std::env::current_exe().unwrap();
    let mut wrapper = Command::new(current_exe)
        .args([
            "--exact",
            "fixture_runs_helper_from_an_outer_job_after_gate",
            "--nocapture",
        ])
        .env_clear()
        .env("EWJL_FIXTURE_MODE", "nested-wrapper")
        .env("EWJL_FIXTURE_GATE", &gate)
        .env("EWJL_FIXTURE_RESULT", &result)
        .env("EWJL_FIXTURE_MARKER", &entry)
        .spawn()
        .unwrap();
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    assert!(!job.is_null());
    let restrictions = JOBOBJECT_BASIC_UI_RESTRICTIONS {
        UIRestrictionsClass: JOB_OBJECT_UILIMIT_HANDLES,
    };
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JobObjectBasicUIRestrictions,
            std::ptr::addr_of!(restrictions).cast(),
            std::mem::size_of_val(&restrictions) as u32,
        )
    };
    assert_ne!(
        configured,
        0,
        "SetInformationJobObject failed: {}",
        unsafe { GetLastError() }
    );
    let assigned = unsafe { AssignProcessToJobObject(job, wrapper.as_raw_handle() as _) };
    if assigned == 0 {
        let host_error = unsafe { GetLastError() };
        let _ = wrapper.kill();
        let _ = wrapper.wait();
        unsafe { CloseHandle(job) };
        eprintln!("nested incompatible fixture skipped: host assignment error {host_error}");
        return;
    }
    fs::write(&gate, b"go").unwrap();
    assert!(wrapper.wait_timeout(Duration::from_secs(15)).is_some());
    let observed = fs::read_to_string(&result).unwrap();
    match observed.as_str() {
        "LaunchFailed|AssignJob|false|0|0" => {
            assert!(
                !entry.exists(),
                "incompatible nested assignment entered the child"
            );
        }
        "TimedOut|None|true|0|0" => {
            assert!(
                entry.exists(),
                "compatible nested assignment never entered the child"
            );
        }
        _ => panic!("unexpected nested-job result: {observed}"),
    }
    unsafe {
        TerminateJobObject(job, 0xe001_0004);
        CloseHandle(job);
    }
    for path in [gate, result, entry] {
        let _ = fs::remove_file(path);
    }
}

#[test]
fn injected_pre_assignment_failure_never_enters_the_child() {
    let marker = unique_marker("injected-before-assign");
    let mut helper = spawn_helper();
    send_launch(
        &mut helper,
        request_with_marker(
            "wait",
            "fixture_waits_after_writing_its_pid",
            10_000,
            1_048_576,
            TestFailure::BeforeAssign,
            &marker,
        ),
    );
    let messages = read_to_completion(&mut helper, Duration::from_secs(10));
    let completion = completion(&messages);
    assert_eq!(completion.status, CompletionStatus::LaunchFailed);
    assert!(
        !marker.exists(),
        "entry marker proves the suspended process ran"
    );
    assert_eq!(helper.wait().unwrap().code(), Some(1));
}

fn spawn_helper() -> Child {
    Command::new(env!("CARGO_BIN_EXE_ever-works-windows-job-launcher"))
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn send_launch(helper: &mut Child, request: LaunchRequest) {
    helper
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&encode_client_message(&ClientMessage::Launch(request)).unwrap())
        .unwrap();
    helper.stdin.as_mut().unwrap().flush().unwrap();
}

fn request(
    mode: &str,
    test_name: &str,
    timeout_ms: u32,
    max_output_bytes: u64,
    test_failure: TestFailure,
) -> LaunchRequest {
    let marker = unique_marker("unused");
    request_with_marker(
        mode,
        test_name,
        timeout_ms,
        max_output_bytes,
        test_failure,
        &marker,
    )
}

fn request_with_marker(
    mode: &str,
    test_name: &str,
    timeout_ms: u32,
    max_output_bytes: u64,
    test_failure: TestFailure,
    marker: &Path,
) -> LaunchRequest {
    LaunchRequest {
        application_path: std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        working_directory: std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        arguments: vec![
            "--exact".to_owned(),
            test_name.to_owned(),
            "--nocapture".to_owned(),
        ],
        environment: vec![
            ("EWJL_FIXTURE_MODE".to_owned(), mode.to_owned()),
            (
                "EWJL_FIXTURE_MARKER".to_owned(),
                marker.to_string_lossy().into_owned(),
            ),
        ],
        timeout_ms,
        cleanup_timeout_ms: 5_000,
        max_output_bytes,
        test_failure,
    }
}

fn read_to_completion(helper: &mut Child, timeout: Duration) -> Vec<ServerMessage> {
    let mut reader = MessageReader::new(helper.stdout.take().unwrap());
    reader.read_completion(timeout)
}

struct MessageReader {
    reads: Receiver<ReadEvent>,
    decoder: ServerFrameDecoder,
    queued: VecDeque<ServerMessage>,
}

impl MessageReader {
    fn new<R: Read + Send + 'static>(mut reader: R) -> Self {
        let (sender, reads) = mpsc::sync_channel(4);
        thread::spawn(move || {
            let mut buffer = [0_u8; 32 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        let _ = sender.send(ReadEvent::Eof);
                        return;
                    }
                    Ok(read) => {
                        if sender
                            .send(ReadEvent::Bytes(buffer[..read].to_vec()))
                            .is_err()
                        {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(ReadEvent::Error(error.kind()));
                        return;
                    }
                }
            }
        });
        Self {
            reads,
            decoder: ServerFrameDecoder::default(),
            queued: VecDeque::new(),
        }
    }

    fn next(&mut self, timeout: Duration) -> ServerMessage {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(message) = self.queued.pop_front() {
                return message;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            match self.reads.recv_timeout(remaining) {
                Ok(ReadEvent::Bytes(bytes)) => {
                    self.queued.extend(self.decoder.push(&bytes).unwrap());
                }
                Ok(ReadEvent::Eof) => panic!("helper protocol closed before completion"),
                Ok(ReadEvent::Error(kind)) => panic!("helper protocol read failed: {kind:?}"),
                Err(RecvTimeoutError::Timeout) => panic!("timed out reading helper protocol"),
                Err(RecvTimeoutError::Disconnected) => {
                    panic!("helper protocol reader disconnected")
                }
            }
        }
    }

    fn read_completion(&mut self, timeout: Duration) -> Vec<ServerMessage> {
        let deadline = Instant::now() + timeout;
        let mut messages = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let message = self.next(remaining);
            let completed = matches!(message, ServerMessage::Completed(_));
            messages.push(message);
            if completed {
                return messages;
            }
        }
    }
}

enum ReadEvent {
    Bytes(Vec<u8>),
    Eof,
    Error(std::io::ErrorKind),
}

fn collect_stream(messages: &[ServerMessage], stdout: bool) -> Vec<u8> {
    messages
        .iter()
        .filter_map(|message| match (stdout, message) {
            (true, ServerMessage::Stdout(bytes)) | (false, ServerMessage::Stderr(bytes)) => {
                Some(bytes.as_slice())
            }
            _ => None,
        })
        .flatten()
        .copied()
        .collect()
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn completion(messages: &[ServerMessage]) -> &Completion {
    messages
        .iter()
        .find_map(|message| match message {
            ServerMessage::Completed(completion) => Some(completion),
            _ => None,
        })
        .expect("completion frame")
}

fn fixture_mode() -> Option<&'static str> {
    match std::env::var("EWJL_FIXTURE_MODE").ok().as_deref() {
        Some("exit") => Some("exit"),
        Some("wait") => Some("wait"),
        Some("flood") => Some("flood"),
        Some("echo") => Some("echo"),
        Some("spawn-detached") => Some("spawn-detached"),
        Some("detached-wait") => Some("detached-wait"),
        Some("nested-wrapper") => Some("nested-wrapper"),
        _ => None,
    }
}

struct BufferFixture;

impl BufferFixture {
    fn first() -> Vec<u8> {
        "stdin-λ-".as_bytes().to_vec()
    }

    fn second() -> Vec<u8> {
        "งาน".as_bytes().to_vec()
    }
}

fn marker_path() -> PathBuf {
    PathBuf::from(std::env::var_os("EWJL_FIXTURE_MARKER").unwrap())
}

fn write_pid_marker() {
    fs::write(marker_path(), std::process::id().to_string()).unwrap();
}

fn wait_for_marker(marker: &Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while !marker.exists() {
        assert!(Instant::now() < deadline, "marker was never written");
        thread::sleep(Duration::from_millis(10));
    }
}

fn assert_process_exited(process_id: u32, timeout: Duration) {
    let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, process_id) };
    if process.is_null() {
        return;
    }
    let result =
        unsafe { WaitForSingleObject(process, timeout.as_millis().try_into().unwrap_or(u32::MAX)) };
    unsafe { CloseHandle(process) };
    assert_eq!(
        result, WAIT_OBJECT_0,
        "root process {process_id} survived helper crash"
    );
}

fn unique_marker(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos();
    std::env::temp_dir().join(format!(
        "ever-works-helper-{label}-{}-{nonce}.marker",
        std::process::id()
    ))
}

trait ChildWaitTimeout {
    fn wait_timeout(&mut self, timeout: Duration) -> Option<std::process::ExitStatus>;
}

impl ChildWaitTimeout for Child {
    fn wait_timeout(&mut self, timeout: Duration) -> Option<std::process::ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.try_wait().unwrap() {
                return Some(status);
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}
