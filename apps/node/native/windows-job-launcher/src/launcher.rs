use crate::protocol::{
    FailureStage, LaunchRequest, TestFailure, encode_environment_block, quote_windows_argument,
};
use std::path::Path;

pub const CREATE_SUSPENDED: u32 = 0x0000_0004;
pub const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
pub const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const TEST_INJECTED_ERROR: u32 = 0xe001_0001;
const FAILURE_EXIT_CODE: u32 = 0xe001_0002;
const ERROR_INVALID_PARAMETER: u32 = 87;
const MAX_CREATE_PROCESS_WIDE_CHARACTERS: usize = 32_767;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct NativeHandle(pub usize);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PipeSet {
    pub child_stdin_read: NativeHandle,
    pub parent_stdin_write: NativeHandle,
    pub parent_stdout_read: NativeHandle,
    pub child_stdout_write: NativeHandle,
    pub parent_stderr_read: NativeHandle,
    pub child_stderr_write: NativeHandle,
}

impl PipeSet {
    fn all(self) -> [NativeHandle; 6] {
        [
            self.child_stdin_read,
            self.parent_stdin_write,
            self.parent_stdout_read,
            self.child_stdout_write,
            self.parent_stderr_read,
            self.child_stderr_write,
        ]
    }

    fn child_ends(self) -> [NativeHandle; 3] {
        [
            self.child_stdin_read,
            self.child_stdout_write,
            self.child_stderr_write,
        ]
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateProcessSpec {
    pub application_path: String,
    pub command_line: String,
    pub working_directory: String,
    pub environment_block: Vec<u16>,
    pub creation_flags: u32,
    pub inherit_handles: bool,
    pub inherited_handles: Vec<NativeHandle>,
    pub stdin_handle: NativeHandle,
    pub stdout_handle: NativeHandle,
    pub stderr_handle: NativeHandle,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SuspendedProcess {
    pub process: NativeHandle,
    pub thread: NativeHandle,
    pub process_id: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PreparedProcess {
    pub job: NativeHandle,
    pub process: NativeHandle,
    pub process_id: u32,
    pub parent_stdin_write: NativeHandle,
    pub parent_stdout_read: NativeHandle,
    pub parent_stderr_read: NativeHandle,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LaunchFailure {
    pub stage: FailureStage,
    pub os_error: u32,
}

pub trait LaunchKernel {
    fn create_job(&mut self) -> Result<NativeHandle, u32>;
    fn set_kill_on_close(&mut self, job: NativeHandle) -> Result<(), u32>;
    fn create_private_pipes(&mut self) -> Result<PipeSet, u32>;
    fn create_process_suspended(
        &mut self,
        spec: &CreateProcessSpec,
    ) -> Result<SuspendedProcess, u32>;
    fn assign_process_to_job(
        &mut self,
        job: NativeHandle,
        process: NativeHandle,
    ) -> Result<(), u32>;
    fn is_process_in_job(&mut self, job: NativeHandle, process: NativeHandle) -> Result<bool, u32>;
    fn resume_thread(&mut self, thread: NativeHandle) -> Result<(), u32>;
    fn terminate_process(&mut self, process: NativeHandle, exit_code: u32) -> Result<(), u32>;
    fn terminate_job(&mut self, job: NativeHandle, exit_code: u32) -> Result<(), u32>;
    fn wait_process_exit(&mut self, process: NativeHandle, timeout_ms: u32) -> Result<bool, u32>;
    fn close_handle(&mut self, handle: NativeHandle);
}

pub fn prepare_process<K: LaunchKernel>(
    kernel: &mut K,
    request: &LaunchRequest,
) -> Result<PreparedProcess, LaunchFailure> {
    validate_paths(request)?;
    let command_line = build_command_line(&request.application_path, &request.arguments);
    let environment_block =
        encode_environment_block(&request.environment).map_err(|_| LaunchFailure {
            stage: FailureStage::CreateProcess,
            os_error: ERROR_INVALID_PARAMETER,
        })?;
    validate_create_process_lengths(request, &command_line, &environment_block)?;
    let job = kernel.create_job().map_err(|os_error| LaunchFailure {
        stage: FailureStage::CreateJob,
        os_error,
    })?;
    if let Err(os_error) = kernel.set_kill_on_close(job) {
        kernel.close_handle(job);
        return Err(LaunchFailure {
            stage: FailureStage::SetLimits,
            os_error,
        });
    }
    let pipes = match kernel.create_private_pipes() {
        Ok(pipes) => pipes,
        Err(os_error) => {
            kernel.close_handle(job);
            return Err(LaunchFailure {
                stage: FailureStage::CreatePipes,
                os_error,
            });
        }
    };
    let spec = CreateProcessSpec {
        application_path: request.application_path.clone(),
        command_line,
        working_directory: request.working_directory.clone(),
        environment_block,
        creation_flags: CREATE_SUSPENDED
            | CREATE_UNICODE_ENVIRONMENT
            | EXTENDED_STARTUPINFO_PRESENT
            | CREATE_NO_WINDOW,
        inherit_handles: true,
        inherited_handles: vec![
            pipes.child_stdin_read,
            pipes.child_stdout_write,
            pipes.child_stderr_write,
        ],
        stdin_handle: pipes.child_stdin_read,
        stdout_handle: pipes.child_stdout_write,
        stderr_handle: pipes.child_stderr_write,
    };
    let child = match kernel.create_process_suspended(&spec) {
        Ok(child) => child,
        Err(os_error) => {
            close_pipes_and_job(kernel, pipes, job);
            return Err(LaunchFailure {
                stage: FailureStage::CreateProcess,
                os_error,
            });
        }
    };

    if request.test_failure == TestFailure::BeforeAssign {
        return fail_after_process(
            kernel,
            job,
            pipes,
            child,
            FailureStage::AssignJob,
            TEST_INJECTED_ERROR,
            request.cleanup_timeout_ms,
        );
    }
    if let Err(os_error) = kernel.assign_process_to_job(job, child.process) {
        return fail_after_process(
            kernel,
            job,
            pipes,
            child,
            FailureStage::AssignJob,
            os_error,
            request.cleanup_timeout_ms,
        );
    }
    if request.test_failure == TestFailure::AfterAssignBeforeMembership {
        return fail_after_process(
            kernel,
            job,
            pipes,
            child,
            FailureStage::VerifyMembership,
            TEST_INJECTED_ERROR,
            request.cleanup_timeout_ms,
        );
    }
    match kernel.is_process_in_job(job, child.process) {
        Ok(true) => {}
        Ok(false) => {
            return fail_after_process(
                kernel,
                job,
                pipes,
                child,
                FailureStage::VerifyMembership,
                0,
                request.cleanup_timeout_ms,
            );
        }
        Err(os_error) => {
            return fail_after_process(
                kernel,
                job,
                pipes,
                child,
                FailureStage::VerifyMembership,
                os_error,
                request.cleanup_timeout_ms,
            );
        }
    }
    if let Err(os_error) = kernel.resume_thread(child.thread) {
        return fail_after_process(
            kernel,
            job,
            pipes,
            child,
            FailureStage::Resume,
            os_error,
            request.cleanup_timeout_ms,
        );
    }

    for handle in pipes.child_ends() {
        kernel.close_handle(handle);
    }
    kernel.close_handle(child.thread);
    Ok(PreparedProcess {
        job,
        process: child.process,
        process_id: child.process_id,
        parent_stdin_write: pipes.parent_stdin_write,
        parent_stdout_read: pipes.parent_stdout_read,
        parent_stderr_read: pipes.parent_stderr_read,
    })
}

fn validate_paths(request: &LaunchRequest) -> Result<(), LaunchFailure> {
    let application = Path::new(&request.application_path);
    let working_directory = Path::new(&request.working_directory);
    let is_script_shim = application
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        });
    if !application.is_absolute() || !working_directory.is_absolute() || is_script_shim {
        return Err(LaunchFailure {
            stage: FailureStage::CreateProcess,
            os_error: ERROR_INVALID_PARAMETER,
        });
    }
    Ok(())
}

fn validate_create_process_lengths(
    request: &LaunchRequest,
    command_line: &str,
    environment_block: &[u16],
) -> Result<(), LaunchFailure> {
    let fits_wide_string = |value: &str| {
        value.encode_utf16().count().saturating_add(1) <= MAX_CREATE_PROCESS_WIDE_CHARACTERS
    };
    if !fits_wide_string(&request.application_path)
        || !fits_wide_string(&request.working_directory)
        || !fits_wide_string(command_line)
        || environment_block.len() > MAX_CREATE_PROCESS_WIDE_CHARACTERS
    {
        return Err(LaunchFailure {
            stage: FailureStage::CreateProcess,
            os_error: ERROR_INVALID_PARAMETER,
        });
    }
    Ok(())
}

fn build_command_line(application_path: &str, arguments: &[String]) -> String {
    std::iter::once(application_path)
        .chain(arguments.iter().map(String::as_str))
        .map(quote_windows_argument)
        .collect::<Vec<_>>()
        .join(" ")
}

fn fail_after_process<K: LaunchKernel>(
    kernel: &mut K,
    job: NativeHandle,
    pipes: PipeSet,
    child: SuspendedProcess,
    stage: FailureStage,
    os_error: u32,
    cleanup_timeout_ms: u32,
) -> Result<PreparedProcess, LaunchFailure> {
    let terminate_error = kernel
        .terminate_process(child.process, FAILURE_EXIT_CODE)
        .err();
    let _ = kernel.terminate_job(job, FAILURE_EXIT_CODE);
    let cleanup_error = match kernel.wait_process_exit(child.process, cleanup_timeout_ms) {
        Ok(true) => None,
        Ok(false) => {
            let retry_error = kernel
                .terminate_process(child.process, FAILURE_EXIT_CODE)
                .err();
            match kernel.wait_process_exit(child.process, 100) {
                Ok(true) => None,
                Ok(false) => retry_error.or(terminate_error).or(Some(258)),
                Err(error) => Some(error),
            }
        }
        Err(error) => Some(error),
    };
    kernel.close_handle(child.thread);
    kernel.close_handle(child.process);
    for handle in pipes.all() {
        kernel.close_handle(handle);
    }
    kernel.close_handle(job);
    Err(match cleanup_error {
        Some(cleanup_error) => LaunchFailure {
            stage: FailureStage::Cleanup,
            os_error: cleanup_error,
        },
        None => LaunchFailure { stage, os_error },
    })
}

fn close_pipes_and_job<K: LaunchKernel>(kernel: &mut K, pipes: PipeSet, job: NativeHandle) {
    for handle in pipes.all() {
        kernel.close_handle(handle);
    }
    kernel.close_handle(job);
}
