use crate::launcher::NativeHandle;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct JobSnapshot {
    pub active_processes: u32,
    pub process_ids: Vec<u32>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct JobVerification {
    pub verified: bool,
    pub snapshot: JobSnapshot,
    pub os_error: u32,
}

pub trait JobQueryKernel {
    fn monotonic_millis(&self) -> u64;
    fn wait_millis(&mut self, milliseconds: u32);
    fn query_job(&mut self, job: NativeHandle) -> Result<JobSnapshot, u32>;
}

pub fn verify_job_empty<K: JobQueryKernel>(
    kernel: &mut K,
    job: NativeHandle,
    timeout_ms: u32,
    poll_ms: u32,
) -> JobVerification {
    let start = kernel.monotonic_millis();
    let deadline = start.saturating_add(u64::from(timeout_ms));
    let poll_ms = poll_ms.max(1);
    let mut consecutive_empty = 0_u8;
    let mut last_snapshot = JobSnapshot::default();

    loop {
        match kernel.query_job(job) {
            Ok(snapshot) => {
                let empty = snapshot.active_processes == 0 && snapshot.process_ids.is_empty();
                last_snapshot = snapshot;
                if empty {
                    consecutive_empty += 1;
                    if consecutive_empty == 2 {
                        return JobVerification {
                            verified: true,
                            snapshot: last_snapshot,
                            os_error: 0,
                        };
                    }
                } else {
                    consecutive_empty = 0;
                }
            }
            Err(os_error) => {
                return JobVerification {
                    verified: false,
                    snapshot: last_snapshot,
                    os_error,
                };
            }
        }

        let now = kernel.monotonic_millis();
        if now >= deadline {
            return JobVerification {
                verified: false,
                snapshot: last_snapshot,
                os_error: 0,
            };
        }
        let remaining = deadline - now;
        kernel.wait_millis(u32::try_from(remaining.min(u64::from(poll_ms))).unwrap_or(poll_ms));
    }
}
