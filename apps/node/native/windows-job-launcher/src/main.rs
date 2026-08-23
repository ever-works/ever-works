#![cfg(windows)]

use std::{
    fs::File,
    io::{Read, Write},
    os::windows::io::FromRawHandle,
    process::ExitCode,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
    },
    thread,
    time::{Duration, Instant},
};

use ever_works_windows_job_launcher::{
    launcher::{LaunchKernel, NativeHandle, PreparedProcess, prepare_process},
    protocol::{
        ClientMessage, Completion, CompletionStatus, FailureStage, FrameDecoder, LaunchRequest,
        ServerMessage, TestFailure, encode_server_message,
    },
    runtime::{JobQueryKernel, JobSnapshot, JobVerification, verify_job_empty},
    windows::WindowsKernel,
};
use windows_sys::Win32::{
    Foundation::{STILL_ACTIVE, WAIT_OBJECT_0},
    System::Threading::{GetExitCodeProcess, WaitForSingleObject},
};

const CONTROL_QUEUE_CAPACITY: usize = 8;
const OUTPUT_QUEUE_CAPACITY: usize = 16;
const WRITER_QUEUE_CAPACITY: usize = 16;
const PIPE_CHUNK_SIZE: usize = 16 * 1024;
const LOOP_POLL_MS: u64 = 5;
const TERMINATION_EXIT_CODE: u32 = 0xe001_0003;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(()) => ExitCode::FAILURE,
    }
}

fn run() -> Result<(), ()> {
    let writer = ProtocolWriter::spawn();
    let control = spawn_control_reader();
    let request = match control.recv() {
        Ok(ControlEvent::Message(ClientMessage::Launch(request))) => request,
        Ok(ControlEvent::ProtocolError)
        | Ok(ControlEvent::Eof)
        | Err(_)
        | Ok(ControlEvent::Message(_)) => {
            write_initial_failure(
                &writer,
                CompletionStatus::ProtocolError,
                FailureStage::Protocol,
                0,
            );
            return Err(());
        }
    };

    if !test_failure_is_allowed(request.test_failure) {
        write_initial_failure(
            &writer,
            CompletionStatus::ProtocolError,
            FailureStage::Protocol,
            0,
        );
        return Err(());
    }

    let mut kernel = WindowsKernel::new();
    let prepared = match prepare_process(&mut kernel, &request) {
        Ok(prepared) => prepared,
        Err(failure) => {
            write_initial_failure(
                &writer,
                CompletionStatus::LaunchFailed,
                failure.stage,
                failure.os_error,
            );
            return Err(());
        }
    };

    if !writer.queue(ServerMessage::Launched {
        root_pid: prepared.process_id,
    }) {
        terminate_and_close(&mut kernel, prepared, request.cleanup_timeout_ms);
        return Err(());
    }

    #[cfg(feature = "test-fixtures")]
    if request.test_failure == TestFailure::AfterResumeAbort {
        writer.flush_bounded(Duration::from_secs(1));
        std::process::abort();
    }

    run_prepared(&mut kernel, prepared, request, control, writer)
}

fn run_prepared(
    kernel: &mut WindowsKernel,
    prepared: PreparedProcess,
    request: LaunchRequest,
    control: Receiver<ControlEvent>,
    writer: ProtocolWriter,
) -> Result<(), ()> {
    let stdin = unsafe { File::from_raw_handle(prepared.parent_stdin_write.0 as _) };
    let stdout = unsafe { File::from_raw_handle(prepared.parent_stdout_read.0 as _) };
    let stderr = unsafe { File::from_raw_handle(prepared.parent_stderr_read.0 as _) };
    let stdin_sender = spawn_stdin_writer(stdin);
    let output_overflow = Arc::new(AtomicBool::new(false));
    let (output, output_streams_closed) =
        spawn_output_readers(stdout, stderr, Arc::clone(&output_overflow));
    let started = Instant::now();
    let deadline = started + Duration::from_millis(u64::from(request.timeout_ms));
    let mut root_exited = false;
    let mut root_exit_code = None;
    let mut consecutive_empty = 0_u8;
    let mut last_snapshot = JobSnapshot::default();
    let mut output_bytes = 0_u64;
    let mut output_limit_hit = false;
    let mut stdin_closed = false;

    let stop = loop {
        if writer.failed.load(Ordering::SeqCst) {
            break StopReason::ParentOutputClosed;
        }
        if output_overflow.load(Ordering::SeqCst) {
            break StopReason::OutputLimit;
        }

        if let Some(reason) = consume_control(&control, &stdin_sender, &mut stdin_closed) {
            break reason;
        }

        loop {
            match output.try_recv() {
                Ok(OutputEvent::Bytes(stream, bytes)) => {
                    let remaining = request.max_output_bytes.saturating_sub(output_bytes);
                    if bytes.len() as u64 > remaining {
                        output_limit_hit = true;
                        if remaining > 0 {
                            let prefix = bytes[..remaining as usize].to_vec();
                            if !writer.queue(stream.message(prefix)) {
                                break;
                            }
                            output_bytes = request.max_output_bytes;
                        }
                        break;
                    }
                    output_bytes += bytes.len() as u64;
                    if !writer.queue(stream.message(bytes)) {
                        break;
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }

        if output_limit_hit
            || output_overflow.load(Ordering::SeqCst)
            || writer.backpressured.load(Ordering::SeqCst)
        {
            break StopReason::OutputLimit;
        }
        if writer.failed.load(Ordering::SeqCst) {
            break StopReason::ParentOutputClosed;
        }

        if !root_exited && process_has_exited(prepared.process) {
            root_exited = true;
            root_exit_code = process_exit_code(prepared.process);
        }
        if root_exited {
            match kernel.query_job(prepared.job) {
                Ok(snapshot) => {
                    let empty = snapshot.active_processes == 0 && snapshot.process_ids.is_empty();
                    last_snapshot = snapshot;
                    if empty {
                        consecutive_empty += 1;
                        if consecutive_empty >= 2
                            && output_streams_closed.load(Ordering::SeqCst) >= 2
                        {
                            break StopReason::Exited;
                        }
                    } else {
                        consecutive_empty = 0;
                    }
                }
                Err(error) => break StopReason::RuntimeError(error),
            }
        }
        if Instant::now() >= deadline {
            break StopReason::TimedOut;
        }
        thread::sleep(Duration::from_millis(LOOP_POLL_MS));
    };

    drop(stdin_sender);
    let (status, verification, failure_stage, os_error) = match stop {
        StopReason::Exited => (
            CompletionStatus::Exited,
            JobVerification {
                verified: true,
                snapshot: last_snapshot,
                os_error: 0,
            },
            FailureStage::None,
            0,
        ),
        StopReason::Cancelled => terminate_and_verify(
            kernel,
            prepared.job,
            request.cleanup_timeout_ms,
            CompletionStatus::Cancelled,
            FailureStage::None,
            0,
        ),
        StopReason::TimedOut => terminate_and_verify(
            kernel,
            prepared.job,
            request.cleanup_timeout_ms,
            CompletionStatus::TimedOut,
            FailureStage::None,
            0,
        ),
        StopReason::OutputLimit => terminate_and_verify(
            kernel,
            prepared.job,
            request.cleanup_timeout_ms,
            CompletionStatus::OutputLimit,
            FailureStage::None,
            0,
        ),
        StopReason::ProtocolError => terminate_and_verify(
            kernel,
            prepared.job,
            request.cleanup_timeout_ms,
            CompletionStatus::ProtocolError,
            FailureStage::Protocol,
            0,
        ),
        StopReason::RuntimeError(error) => terminate_and_verify(
            kernel,
            prepared.job,
            request.cleanup_timeout_ms,
            CompletionStatus::ProtocolError,
            FailureStage::Runtime,
            error,
        ),
        StopReason::ParentEof | StopReason::ParentOutputClosed => {
            let _ = kernel.terminate_job(prepared.job, TERMINATION_EXIT_CODE);
            let _ = verify_job_empty(
                kernel,
                prepared.job,
                request.cleanup_timeout_ms,
                LOOP_POLL_MS as u32,
            );
            kernel.close_handle(prepared.process);
            kernel.close_handle(prepared.job);
            return Ok(());
        }
    };

    if root_exit_code.is_none() {
        root_exit_code = process_exit_code(prepared.process);
    }
    let completion_status = if verification.verified {
        status
    } else {
        CompletionStatus::TerminationUnverified
    };
    let completion = Completion {
        status: completion_status,
        exit_code: root_exit_code,
        root_pid: prepared.process_id,
        termination_verified: verification.verified,
        active_processes: verification.snapshot.active_processes,
        process_ids: verification.snapshot.process_ids,
        failure_stage: if verification.verified {
            failure_stage
        } else {
            FailureStage::Cleanup
        },
        os_error: if verification.verified {
            os_error
        } else {
            verification.os_error
        },
    };
    let queued = writer.queue(ServerMessage::Completed(completion));
    kernel.close_handle(prepared.process);
    kernel.close_handle(prepared.job);
    if queued {
        writer.flush_bounded(Duration::from_secs(1));
    }
    if completion_status == CompletionStatus::TerminationUnverified {
        Err(())
    } else {
        Ok(())
    }
}

fn consume_control(
    control: &Receiver<ControlEvent>,
    stdin: &SyncSender<StdinCommand>,
    stdin_closed: &mut bool,
) -> Option<StopReason> {
    loop {
        match control.try_recv() {
            Ok(ControlEvent::Message(ClientMessage::Stdin(bytes))) if !*stdin_closed => {
                if stdin.try_send(StdinCommand::Write(bytes)).is_err() {
                    return Some(StopReason::ProtocolError);
                }
            }
            Ok(ControlEvent::Message(ClientMessage::CloseStdin)) if !*stdin_closed => {
                *stdin_closed = true;
                if stdin.try_send(StdinCommand::Close).is_err() {
                    return Some(StopReason::ProtocolError);
                }
            }
            Ok(ControlEvent::Message(ClientMessage::Cancel)) => return Some(StopReason::Cancelled),
            Ok(ControlEvent::Eof) | Err(TryRecvError::Disconnected) => {
                return Some(StopReason::ParentEof);
            }
            Ok(ControlEvent::ProtocolError) | Ok(ControlEvent::Message(_)) => {
                return Some(StopReason::ProtocolError);
            }
            Err(TryRecvError::Empty) => return None,
        }
    }
}

fn terminate_and_verify(
    kernel: &mut WindowsKernel,
    job: NativeHandle,
    cleanup_timeout_ms: u32,
    status: CompletionStatus,
    failure_stage: FailureStage,
    os_error: u32,
) -> (CompletionStatus, JobVerification, FailureStage, u32) {
    let _ = kernel.terminate_job(job, TERMINATION_EXIT_CODE);
    let verification = verify_job_empty(kernel, job, cleanup_timeout_ms, LOOP_POLL_MS as u32);
    (status, verification, failure_stage, os_error)
}

fn terminate_and_close(
    kernel: &mut WindowsKernel,
    prepared: PreparedProcess,
    cleanup_timeout_ms: u32,
) {
    let _ = kernel.terminate_job(prepared.job, TERMINATION_EXIT_CODE);
    let _ = verify_job_empty(
        kernel,
        prepared.job,
        cleanup_timeout_ms,
        LOOP_POLL_MS as u32,
    );
    for handle in [
        prepared.parent_stdin_write,
        prepared.parent_stdout_read,
        prepared.parent_stderr_read,
        prepared.process,
        prepared.job,
    ] {
        kernel.close_handle(handle);
    }
}

fn write_initial_failure(
    writer: &ProtocolWriter,
    status: CompletionStatus,
    failure_stage: FailureStage,
    os_error: u32,
) {
    writer.queue(ServerMessage::Completed(Completion {
        status,
        exit_code: None,
        root_pid: 0,
        termination_verified: false,
        active_processes: 0,
        process_ids: Vec::new(),
        failure_stage,
        os_error,
    }));
    writer.flush_bounded(Duration::from_secs(1));
}

fn test_failure_is_allowed(test_failure: TestFailure) -> bool {
    if test_failure == TestFailure::None {
        return true;
    }
    #[cfg(feature = "test-fixtures")]
    {
        true
    }
    #[cfg(not(feature = "test-fixtures"))]
    {
        false
    }
}

#[derive(Debug)]
enum ControlEvent {
    Message(ClientMessage),
    Eof,
    ProtocolError,
}

fn spawn_control_reader() -> Receiver<ControlEvent> {
    let (sender, receiver) = mpsc::sync_channel(CONTROL_QUEUE_CAPACITY);
    thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut stdin = stdin.lock();
        let mut decoder = FrameDecoder::default();
        let mut buffer = [0_u8; PIPE_CHUNK_SIZE];
        loop {
            match stdin.read(&mut buffer) {
                Ok(0) => {
                    let event = if decoder.has_pending_bytes() {
                        ControlEvent::ProtocolError
                    } else {
                        ControlEvent::Eof
                    };
                    let _ = sender.send(event);
                    return;
                }
                Ok(read) => match decoder.push(&buffer[..read]) {
                    Ok(messages) => {
                        for message in messages {
                            if sender.send(ControlEvent::Message(message)).is_err() {
                                return;
                            }
                        }
                    }
                    Err(_) => {
                        let _ = sender.send(ControlEvent::ProtocolError);
                        return;
                    }
                },
                Err(_) => {
                    let _ = sender.send(ControlEvent::Eof);
                    return;
                }
            }
        }
    });
    receiver
}

enum StdinCommand {
    Write(Vec<u8>),
    Close,
}

fn spawn_stdin_writer(mut file: File) -> SyncSender<StdinCommand> {
    let (sender, receiver) = mpsc::sync_channel(CONTROL_QUEUE_CAPACITY);
    thread::spawn(move || {
        while let Ok(command) = receiver.recv() {
            match command {
                StdinCommand::Write(bytes) if file.write_all(&bytes).is_ok() => {}
                StdinCommand::Write(_) | StdinCommand::Close => return,
            }
        }
    });
    sender
}

#[derive(Clone, Copy)]
enum OutputStream {
    Stdout,
    Stderr,
}

impl OutputStream {
    fn message(self, bytes: Vec<u8>) -> ServerMessage {
        match self {
            Self::Stdout => ServerMessage::Stdout(bytes),
            Self::Stderr => ServerMessage::Stderr(bytes),
        }
    }
}

enum OutputEvent {
    Bytes(OutputStream, Vec<u8>),
}

fn spawn_output_readers(
    stdout: File,
    stderr: File,
    overflow: Arc<AtomicBool>,
) -> (Receiver<OutputEvent>, Arc<AtomicUsize>) {
    let (sender, receiver) = mpsc::sync_channel(OUTPUT_QUEUE_CAPACITY);
    let closed = Arc::new(AtomicUsize::new(0));
    spawn_output_reader(
        stdout,
        OutputStream::Stdout,
        sender.clone(),
        Arc::clone(&overflow),
        Arc::clone(&closed),
    );
    spawn_output_reader(
        stderr,
        OutputStream::Stderr,
        sender,
        overflow,
        Arc::clone(&closed),
    );
    (receiver, closed)
}

fn spawn_output_reader(
    mut file: File,
    stream: OutputStream,
    sender: SyncSender<OutputEvent>,
    overflow: Arc<AtomicBool>,
    closed: Arc<AtomicUsize>,
) {
    thread::spawn(move || {
        let _close_signal = OutputReaderCloseSignal(closed);
        let mut buffer = [0_u8; PIPE_CHUNK_SIZE];
        loop {
            match file.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    match sender.try_send(OutputEvent::Bytes(stream, buffer[..read].to_vec())) {
                        Ok(()) => {}
                        Err(TrySendError::Full(_)) => {
                            overflow.store(true, Ordering::SeqCst);
                            return;
                        }
                        Err(TrySendError::Disconnected(_)) => return,
                    }
                }
                Err(_) => break,
            }
        }
    });
}

struct OutputReaderCloseSignal(Arc<AtomicUsize>);

impl Drop for OutputReaderCloseSignal {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

struct ProtocolWriter {
    sender: SyncSender<Vec<u8>>,
    queued: Arc<AtomicUsize>,
    written: Arc<AtomicUsize>,
    failed: Arc<AtomicBool>,
    backpressured: Arc<AtomicBool>,
}

impl ProtocolWriter {
    fn spawn() -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(WRITER_QUEUE_CAPACITY);
        let queued = Arc::new(AtomicUsize::new(0));
        let written = Arc::new(AtomicUsize::new(0));
        let failed = Arc::new(AtomicBool::new(false));
        let backpressured = Arc::new(AtomicBool::new(false));
        let thread_written = Arc::clone(&written);
        let thread_failed = Arc::clone(&failed);
        thread::spawn(move || {
            let stdout = std::io::stdout();
            let mut stdout = stdout.lock();
            while let Ok(frame) = receiver.recv() {
                if stdout
                    .write_all(&frame)
                    .and_then(|()| stdout.flush())
                    .is_err()
                {
                    thread_failed.store(true, Ordering::SeqCst);
                    return;
                }
                thread_written.fetch_add(1, Ordering::SeqCst);
            }
        });
        Self {
            sender,
            queued,
            written,
            failed,
            backpressured,
        }
    }

    fn queue(&self, message: ServerMessage) -> bool {
        let Ok(frame) = encode_server_message(&message) else {
            return false;
        };
        match self.sender.try_send(frame) {
            Ok(()) => {
                self.queued.fetch_add(1, Ordering::SeqCst);
                true
            }
            Err(TrySendError::Full(_)) => {
                self.backpressured.store(true, Ordering::SeqCst);
                false
            }
            Err(TrySendError::Disconnected(_)) => {
                self.failed.store(true, Ordering::SeqCst);
                false
            }
        }
    }

    fn flush_bounded(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let target = self.queued.load(Ordering::SeqCst);
        while self.written.load(Ordering::SeqCst) < target && !self.failed.load(Ordering::SeqCst) {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(1));
        }
        !self.failed.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StopReason {
    Exited,
    Cancelled,
    TimedOut,
    OutputLimit,
    ProtocolError,
    RuntimeError(u32),
    ParentEof,
    ParentOutputClosed,
}

fn process_has_exited(process: NativeHandle) -> bool {
    (unsafe { WaitForSingleObject(process.0 as _, 0) }) == WAIT_OBJECT_0
}

fn process_exit_code(process: NativeHandle) -> Option<i32> {
    let mut exit_code = STILL_ACTIVE as u32;
    let success = unsafe { GetExitCodeProcess(process.0 as _, &mut exit_code) };
    (success != 0 && exit_code != STILL_ACTIVE as u32).then_some(exit_code as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_launches_never_require_failure_injection() {
        assert!(test_failure_is_allowed(TestFailure::None));
    }

    #[test]
    fn failure_injection_is_compiled_out_of_the_default_helper() {
        #[cfg(not(feature = "test-fixtures"))]
        for injection in [
            TestFailure::BeforeAssign,
            TestFailure::AfterAssignBeforeMembership,
            TestFailure::AfterResumeAbort,
        ] {
            assert!(!test_failure_is_allowed(injection));
        }

        #[cfg(feature = "test-fixtures")]
        for injection in [
            TestFailure::BeforeAssign,
            TestFailure::AfterAssignBeforeMembership,
            TestFailure::AfterResumeAbort,
        ] {
            assert!(test_failure_is_allowed(injection));
        }
    }
}
