use std::collections::VecDeque;

use ever_works_windows_job_launcher::{
    launcher::NativeHandle,
    runtime::{JobQueryKernel, JobSnapshot, verify_job_empty},
};

struct FakeQueryKernel {
    now_ms: u64,
    snapshots: VecDeque<Result<JobSnapshot, u32>>,
    last_snapshot: Result<JobSnapshot, u32>,
}

impl FakeQueryKernel {
    fn new(snapshots: Vec<Result<JobSnapshot, u32>>) -> Self {
        let last_snapshot = snapshots.last().cloned().unwrap();
        Self {
            now_ms: 0,
            snapshots: snapshots.into(),
            last_snapshot,
        }
    }
}

impl JobQueryKernel for FakeQueryKernel {
    fn monotonic_millis(&self) -> u64 {
        self.now_ms
    }

    fn wait_millis(&mut self, milliseconds: u32) {
        self.now_ms += u64::from(milliseconds);
    }

    fn query_job(&mut self, _job: NativeHandle) -> Result<JobSnapshot, u32> {
        self.snapshots
            .pop_front()
            .unwrap_or_else(|| self.last_snapshot.clone())
    }
}

#[test]
fn verifies_only_after_two_consecutive_zero_active_and_empty_pid_snapshots() {
    let mut kernel = FakeQueryKernel::new(vec![
        Ok(snapshot(1, &[41])),
        Ok(snapshot(0, &[41])),
        Ok(snapshot(0, &[])),
        Ok(snapshot(0, &[])),
    ]);
    let result = verify_job_empty(&mut kernel, NativeHandle(1), 100, 5);

    assert!(result.verified);
    assert_eq!(result.snapshot, snapshot(0, &[]));
    assert_eq!(result.os_error, 0);
    assert_eq!(kernel.now_ms, 15);
}

#[test]
fn active_zero_with_a_pid_list_never_counts_as_verified() {
    let mut kernel = FakeQueryKernel::new(vec![Ok(snapshot(0, &[99]))]);
    let result = verify_job_empty(&mut kernel, NativeHandle(1), 20, 5);

    assert!(!result.verified);
    assert_eq!(result.snapshot, snapshot(0, &[99]));
    assert_eq!(kernel.now_ms, 20);
}

#[test]
fn active_processes_with_an_empty_pid_list_never_counts_as_verified() {
    let mut kernel = FakeQueryKernel::new(vec![Ok(snapshot(1, &[]))]);
    let result = verify_job_empty(&mut kernel, NativeHandle(1), 20, 5);

    assert!(!result.verified);
    assert_eq!(result.snapshot, snapshot(1, &[]));
}

#[test]
fn query_failure_is_unverified_and_preserves_only_the_numeric_os_error() {
    let mut kernel = FakeQueryKernel::new(vec![Err(5)]);
    let result = verify_job_empty(&mut kernel, NativeHandle(1), 100, 5);

    assert!(!result.verified);
    assert_eq!(result.snapshot, snapshot(0, &[]));
    assert_eq!(result.os_error, 5);
}

fn snapshot(active_processes: u32, process_ids: &[u32]) -> JobSnapshot {
    JobSnapshot {
        active_processes,
        process_ids: process_ids.to_vec(),
    }
}
