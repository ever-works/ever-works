#![cfg(windows)]

use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use ever_works_windows_job_launcher::{
    launcher::{LaunchKernel, prepare_process},
    protocol::{LaunchRequest, TestFailure},
    runtime::verify_job_empty,
    windows::WindowsKernel,
};
use windows_sys::Win32::{
    Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::WaitForSingleObject,
};

#[test]
fn fixture_entry_writes_marker() {
    if let Some(marker) = std::env::var_os("EWJL_TEST_ENTRY_MARKER") {
        fs::write(marker, b"entered").unwrap();
    }
}

#[test]
fn real_kernel_does_not_enter_child_before_an_injected_assignment_failure() {
    let marker = unique_marker("before-assign");
    let request = fixture_request(&marker, TestFailure::BeforeAssign);
    let mut kernel = WindowsKernel::new();

    let failure = prepare_process(&mut kernel, &request).unwrap_err();

    assert_eq!(failure.stage as u16, 5);
    assert!(
        !marker.exists(),
        "the suspended child executed before verified assignment"
    );
}

#[test]
fn real_kernel_assigns_resumes_and_verifies_the_job_is_empty() {
    let marker = unique_marker("success");
    let request = fixture_request(&marker, TestFailure::None);
    let mut kernel = WindowsKernel::new();
    let prepared = prepare_process(&mut kernel, &request).unwrap();

    let wait = unsafe { WaitForSingleObject(prepared.process.0 as _, 10_000) };
    assert_eq!(wait, WAIT_OBJECT_0, "child wait returned {wait}");
    assert_ne!(wait, WAIT_TIMEOUT);
    let verification = verify_job_empty(&mut kernel, prepared.job, 5_000, 10);
    assert!(verification.verified, "{verification:?}");
    assert_eq!(verification.snapshot.active_processes, 0);
    assert!(verification.snapshot.process_ids.is_empty());
    assert_eq!(fs::read(&marker).unwrap(), b"entered");

    kernel.close_handle(prepared.parent_stdin_write);
    kernel.close_handle(prepared.parent_stdout_read);
    kernel.close_handle(prepared.parent_stderr_read);
    kernel.close_handle(prepared.process);
    kernel.close_handle(prepared.job);
    let _ = fs::remove_file(marker);
}

fn fixture_request(marker: &Path, test_failure: TestFailure) -> LaunchRequest {
    let current_exe = std::env::current_exe().unwrap();
    LaunchRequest {
        application_path: current_exe.to_string_lossy().into_owned(),
        working_directory: std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        arguments: vec![
            "--exact".to_owned(),
            "fixture_entry_writes_marker".to_owned(),
            "--nocapture".to_owned(),
        ],
        environment: vec![(
            "EWJL_TEST_ENTRY_MARKER".to_owned(),
            marker.to_string_lossy().into_owned(),
        )],
        timeout_ms: 10_000,
        cleanup_timeout_ms: 5_000,
        max_output_bytes: 1_048_576,
        test_failure,
    }
}

fn unique_marker(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos();
    std::env::temp_dir().join(format!(
        "ever-works-job-launcher-{label}-{}-{nonce}.marker",
        std::process::id()
    ))
}
