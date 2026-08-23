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
    runtime::{JobQueryKernel, JobVerification, verify_job_empty},
    windows::WindowsKernel,
};
use windows_sys::Win32::{
    Foundation::{GetLastError, WAIT_OBJECT_0},
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
        Ok(ControlEvent::TransportError(os_error)) => {
            write_initial_failure(
                &writer,
                CompletionStatus::ProtocolError,
                FailureStage::Protocol,
                os_error,
            );
            return Err(());
        }
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
    let output_reader_start_delay = test_output_reader_start_delay(&request);
    let output = spawn_output_readers(
        stdout,
        stderr,
        Arc::clone(&output_overflow),
        output_reader_start_delay,
    );
    let started = Instant::now();
    let deadline = started + Duration::from_millis(u64::from(request.timeout_ms));
    let mut root_exit_code = None;
    let mut output_bytes = 0_u64;
    let mut output_limit_hit = false;
    let mut output_streams = OutputStreamsState::default();
    let mut stdin_closed = false;

    let stop = loop {
        if output_overflow.load(Ordering::SeqCst) {
            break StopReason::OutputLimit;
        }

        if let Some(reason) = consume_control(&control, &stdin_sender, &mut stdin_closed) {
            break reason;
        }
        if writer.failed.load(Ordering::SeqCst) {
            break StopReason::ParentOutputClosed;
        }

        let mut output_read_error = None;
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
                Ok(OutputEvent::Eof(stream)) => output_streams.mark_eof(stream),
                Ok(OutputEvent::ReadError(os_error)) => {
                    output_read_error = Some(os_error);
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    if !output_streams.all_eof() {
                        output_read_error = Some(0);
                    }
                    break;
                }
            }
        }

        if let Some(os_error) = output_read_error {
            break StopReason::OutputReadError(os_error);
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

        if process_has_exited(prepared.process) {
            match process_exit_code(prepared.process) {
                Ok(exit_code) => {
                    root_exit_code = Some(exit_code);
                    break StopReason::Exited;
                }
                Err(os_error) => break StopReason::ExitCodeUnavailable(os_error),
            }
        }
        if Instant::now() >= deadline {
            break StopReason::TimedOut;
        }
        thread::sleep(Duration::from_millis(LOOP_POLL_MS));
    };

    drop(stdin_sender);
    let capture_exit_code_after_cleanup = !matches!(
        stop,
        StopReason::Exited | StopReason::ExitCodeUnavailable(_)
    );
    let (mut status, mut verification, mut failure_stage, mut os_error) = match stop {
        StopReason::Exited => terminate_and_verify(
            kernel,
            prepared.job,
            request.cleanup_timeout_ms,
            CompletionStatus::Exited,
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
        StopReason::ControlTransportError(os_error) => terminate_and_verify(
            kernel,
            prepared.job,
            request.cleanup_timeout_ms,
            CompletionStatus::ProtocolError,
            FailureStage::Protocol,
            os_error,
        ),
        StopReason::ExitCodeUnavailable(os_error) => terminate_and_verify(
            kernel,
            prepared.job,
            request.cleanup_timeout_ms,
            CompletionStatus::ProtocolError,
            FailureStage::Runtime,
            os_error,
        ),
        StopReason::OutputReadError(os_error) => terminate_and_verify(
            kernel,
            prepared.job,
            request.cleanup_timeout_ms,
            CompletionStatus::ProtocolError,
            FailureStage::Runtime,
            os_error,
        ),
        StopReason::ParentEof => terminate_and_verify(
            kernel,
            prepared.job,
            request.cleanup_timeout_ms,
            CompletionStatus::Cancelled,
            FailureStage::None,
            0,
        ),
        StopReason::ParentOutputClosed => {
            let _cleanup = terminate_and_verify(
                kernel,
                prepared.job,
                request.cleanup_timeout_ms,
                CompletionStatus::Cancelled,
                FailureStage::None,
                0,
            );
            kernel.close_handle(prepared.process);
            kernel.close_handle(prepared.job);
            return Err(());
        }
    };

    match drain_output_after_cleanup(
        &output,
        &mut output_streams,
        &output_overflow,
        &writer,
        &mut output_bytes,
        request.max_output_bytes,
        request.cleanup_timeout_ms,
    ) {
        OutputDrainResult::Complete => {}
        OutputDrainResult::OutputLimit => status = CompletionStatus::OutputLimit,
        OutputDrainResult::ReadFailed(error) => {
            status = CompletionStatus::ProtocolError;
            failure_stage = FailureStage::Runtime;
            os_error = error;
        }
        OutputDrainResult::WriterFailed => {
            kernel.close_handle(prepared.process);
            kernel.close_handle(prepared.job);
            return Err(());
        }
        OutputDrainResult::TimedOut => {
            verification.verified = false;
            verification.os_error = 0;
        }
    }

    if root_exit_code.is_none() && capture_exit_code_after_cleanup {
        root_exit_code = process_exit_code(prepared.process).ok();
    }
    let completion = build_completion(
        status,
        verification,
        failure_stage,
        os_error,
        prepared.process_id,
        root_exit_code,
    );
    let completion_status = completion.status;
    let queued = writer.queue_bounded(ServerMessage::Completed(completion), Duration::from_secs(1));
    kernel.close_handle(prepared.process);
    kernel.close_handle(prepared.job);
    let flushed = queued && writer.flush_bounded(Duration::from_secs(1));
    if !flushed
        || matches!(
            completion_status,
            CompletionStatus::OutputLimit
                | CompletionStatus::ProtocolError
                | CompletionStatus::TerminationUnverified
        )
    {
        Err(())
    } else {
        Ok(())
    }
}

fn build_completion(
    status: CompletionStatus,
    verification: JobVerification,
    failure_stage: FailureStage,
    os_error: u32,
    root_pid: u32,
    root_exit_code: Option<u32>,
) -> Completion {
    let verified = verification.verified;
    Completion {
        status: if verified {
            status
        } else {
            CompletionStatus::TerminationUnverified
        },
        exit_code: root_exit_code,
        root_pid,
        termination_verified: verified,
        active_processes: verification.snapshot.active_processes,
        process_ids: verification.snapshot.process_ids,
        failure_stage: if verified {
            failure_stage
        } else {
            FailureStage::Cleanup
        },
        os_error: if verified {
            os_error
        } else {
            verification.os_error
        },
    }
}

enum OutputDrainResult {
    Complete,
    OutputLimit,
    ReadFailed(u32),
    WriterFailed,
    TimedOut,
}

fn drain_output_after_cleanup(
    output: &Receiver<OutputEvent>,
    streams: &mut OutputStreamsState,
    overflow: &AtomicBool,
    writer: &ProtocolWriter,
    output_bytes: &mut u64,
    max_output_bytes: u64,
    cleanup_timeout_ms: u32,
) -> OutputDrainResult {
    let deadline = Instant::now() + Duration::from_millis(u64::from(cleanup_timeout_ms));
    loop {
        let mut disconnected = false;
        loop {
            match output.try_recv() {
                Ok(OutputEvent::Bytes(stream, bytes)) => {
                    let remaining = max_output_bytes.saturating_sub(*output_bytes);
                    if bytes.len() as u64 > remaining {
                        if remaining > 0 {
                            let prefix = bytes[..remaining as usize].to_vec();
                            if !writer.queue(stream.message(prefix)) {
                                return if writer.failed.load(Ordering::SeqCst) {
                                    OutputDrainResult::WriterFailed
                                } else {
                                    OutputDrainResult::OutputLimit
                                };
                            }
                            *output_bytes = max_output_bytes;
                        }
                        return OutputDrainResult::OutputLimit;
                    }
                    *output_bytes += bytes.len() as u64;
                    if !writer.queue(stream.message(bytes)) {
                        return if writer.failed.load(Ordering::SeqCst) {
                            OutputDrainResult::WriterFailed
                        } else {
                            OutputDrainResult::OutputLimit
                        };
                    }
                }
                Ok(OutputEvent::Eof(stream)) => streams.mark_eof(stream),
                Ok(OutputEvent::ReadError(os_error)) => {
                    return OutputDrainResult::ReadFailed(os_error);
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }

        if overflow.load(Ordering::SeqCst) || writer.backpressured.load(Ordering::SeqCst) {
            return OutputDrainResult::OutputLimit;
        }
        if writer.failed.load(Ordering::SeqCst) {
            return OutputDrainResult::WriterFailed;
        }
        if streams.all_eof() {
            return OutputDrainResult::Complete;
        }
        if disconnected {
            return OutputDrainResult::ReadFailed(0);
        }
        if Instant::now() >= deadline {
            return OutputDrainResult::TimedOut;
        }
        thread::sleep(Duration::from_millis(1));
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
            Ok(ControlEvent::Eof) => return Some(StopReason::ParentEof),
            Ok(ControlEvent::TransportError(os_error)) => {
                return Some(StopReason::ControlTransportError(os_error));
            }
            Err(TryRecvError::Disconnected) => {
                return Some(StopReason::ControlTransportError(0));
            }
            Ok(ControlEvent::ProtocolError) | Ok(ControlEvent::Message(_)) => {
                return Some(StopReason::ProtocolError);
            }
            Err(TryRecvError::Empty) => return None,
        }
    }
}

trait CleanupKernel: JobQueryKernel {
    fn terminate_for_cleanup(&mut self, job: NativeHandle, exit_code: u32) -> Result<(), u32>;
}

impl CleanupKernel for WindowsKernel {
    fn terminate_for_cleanup(&mut self, job: NativeHandle, exit_code: u32) -> Result<(), u32> {
        LaunchKernel::terminate_job(self, job, exit_code)
    }
}

fn terminate_and_verify<K: CleanupKernel>(
    kernel: &mut K,
    job: NativeHandle,
    cleanup_timeout_ms: u32,
    status: CompletionStatus,
    failure_stage: FailureStage,
    os_error: u32,
) -> (CompletionStatus, JobVerification, FailureStage, u32) {
    let termination_error = kernel
        .terminate_for_cleanup(job, TERMINATION_EXIT_CODE)
        .err();
    let mut verification = verify_job_empty(kernel, job, cleanup_timeout_ms, LOOP_POLL_MS as u32);
    if let Some(os_error) = termination_error {
        verification.verified = false;
        verification.os_error = os_error;
    }
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
    TransportError(u32),
}

fn spawn_control_reader() -> Receiver<ControlEvent> {
    let (sender, receiver) = mpsc::sync_channel(CONTROL_QUEUE_CAPACITY);
    thread::spawn(move || {
        let stdin = std::io::stdin();
        read_control(stdin.lock(), sender);
    });
    receiver
}

fn read_control<R: Read>(mut reader: R, sender: SyncSender<ControlEvent>) {
    let mut decoder = FrameDecoder::default();
    let mut buffer = [0_u8; PIPE_CHUNK_SIZE];
    loop {
        match reader.read(&mut buffer) {
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
            Err(error) => {
                let os_error = error
                    .raw_os_error()
                    .and_then(|value| u32::try_from(value).ok())
                    .unwrap_or(0);
                let _ = sender.send(ControlEvent::TransportError(os_error));
                return;
            }
        }
    }
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
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
    Eof(OutputStream),
    ReadError(u32),
}

#[derive(Default)]
struct OutputStreamsState {
    stdout_eof: bool,
    stderr_eof: bool,
}

impl OutputStreamsState {
    fn mark_eof(&mut self, stream: OutputStream) {
        match stream {
            OutputStream::Stdout => self.stdout_eof = true,
            OutputStream::Stderr => self.stderr_eof = true,
        }
    }

    fn all_eof(&self) -> bool {
        self.stdout_eof && self.stderr_eof
    }
}

fn spawn_output_readers(
    stdout: File,
    stderr: File,
    overflow: Arc<AtomicBool>,
    start_delay: Duration,
) -> Receiver<OutputEvent> {
    let (sender, receiver) = mpsc::sync_channel(OUTPUT_QUEUE_CAPACITY);
    spawn_output_reader(
        stdout,
        OutputStream::Stdout,
        sender.clone(),
        Arc::clone(&overflow),
        start_delay,
    );
    spawn_output_reader(stderr, OutputStream::Stderr, sender, overflow, start_delay);
    receiver
}

fn spawn_output_reader<R: Read + Send + 'static>(
    mut reader: R,
    stream: OutputStream,
    sender: SyncSender<OutputEvent>,
    overflow: Arc<AtomicBool>,
    start_delay: Duration,
) {
    thread::spawn(move || {
        if !start_delay.is_zero() {
            thread::sleep(start_delay);
        }
        let mut buffer = [0_u8; PIPE_CHUNK_SIZE];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = sender.send(OutputEvent::Eof(stream));
                    return;
                }
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
                Err(error) => {
                    let os_error = error
                        .raw_os_error()
                        .and_then(|value| u32::try_from(value).ok())
                        .unwrap_or(0);
                    let _ = sender.send(OutputEvent::ReadError(os_error));
                    return;
                }
            }
        }
    });
}

#[cfg(feature = "test-fixtures")]
fn test_output_reader_start_delay(request: &LaunchRequest) -> Duration {
    const NAME: &str = "EWJL_TEST_OUTPUT_READER_DELAY_MS";
    if let Some((_, value)) = request.environment.iter().find(|(name, _)| name == NAME) {
        return Duration::from_millis(value.parse::<u64>().unwrap_or(0).min(1_000));
    }
    Duration::ZERO
}

#[cfg(not(feature = "test-fixtures"))]
fn test_output_reader_start_delay(_request: &LaunchRequest) -> Duration {
    Duration::ZERO
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

    fn queue_bounded(&self, message: ServerMessage, timeout: Duration) -> bool {
        let Ok(mut frame) = encode_server_message(&message) else {
            return false;
        };
        let deadline = Instant::now() + timeout;
        loop {
            match self.sender.try_send(frame) {
                Ok(()) => {
                    self.queued.fetch_add(1, Ordering::SeqCst);
                    return true;
                }
                Err(TrySendError::Full(returned)) => {
                    frame = returned;
                    if self.failed.load(Ordering::SeqCst) || Instant::now() >= deadline {
                        self.backpressured.store(true, Ordering::SeqCst);
                        return false;
                    }
                    thread::sleep(Duration::from_millis(1));
                }
                Err(TrySendError::Disconnected(_)) => {
                    self.failed.store(true, Ordering::SeqCst);
                    return false;
                }
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
    ExitCodeUnavailable(u32),
    OutputReadError(u32),
    Cancelled,
    TimedOut,
    OutputLimit,
    ProtocolError,
    ControlTransportError(u32),
    ParentEof,
    ParentOutputClosed,
}

fn process_has_exited(process: NativeHandle) -> bool {
    (unsafe { WaitForSingleObject(process.0 as _, 0) }) == WAIT_OBJECT_0
}

fn process_exit_code(process: NativeHandle) -> Result<u32, u32> {
    let mut exit_code = 0_u32;
    let success = unsafe { GetExitCodeProcess(process.0 as _, &mut exit_code) };
    if success == 0 {
        Err(unsafe { GetLastError() })
    } else {
        Ok(exit_code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ever_works_windows_job_launcher::runtime::JobSnapshot;
    use std::{
        collections::VecDeque,
        io::{self, Cursor},
        sync::mpsc::RecvTimeoutError,
    };

    struct BytesThenReadError {
        bytes: Cursor<Vec<u8>>,
        os_error: i32,
    }

    impl Read for BytesThenReadError {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let read = self.bytes.read(buffer)?;
            if read == 0 {
                Err(io::Error::from_raw_os_error(self.os_error))
            } else {
                Ok(read)
            }
        }
    }

    struct FakeCleanupKernel {
        now_ms: u64,
        terminate_result: Result<(), u32>,
        snapshots: VecDeque<Result<JobSnapshot, u32>>,
        last_snapshot: Result<JobSnapshot, u32>,
    }

    impl FakeCleanupKernel {
        fn new(
            terminate_result: Result<(), u32>,
            snapshots: Vec<Result<JobSnapshot, u32>>,
        ) -> Self {
            let last_snapshot = snapshots.last().cloned().unwrap();
            Self {
                now_ms: 0,
                terminate_result,
                snapshots: snapshots.into(),
                last_snapshot,
            }
        }
    }

    impl CleanupKernel for FakeCleanupKernel {
        fn terminate_for_cleanup(
            &mut self,
            _job: NativeHandle,
            _exit_code: u32,
        ) -> Result<(), u32> {
            self.terminate_result
        }
    }

    impl JobQueryKernel for FakeCleanupKernel {
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
    fn cleanup_verified_control_loss_is_reported_as_cancelled() {
        let completion = control_loss_completion(FakeCleanupKernel::new(
            Ok(()),
            vec![Ok(empty_snapshot()), Ok(empty_snapshot())],
        ));

        assert_eq!(completion.status, CompletionStatus::Cancelled);
        assert!(completion.termination_verified);
        assert_eq!(completion.failure_stage, FailureStage::None);
        assert_eq!(completion.os_error, 0);
    }

    #[test]
    fn cleanup_termination_failure_is_never_reported_as_verified_control_loss() {
        let completion = control_loss_completion(FakeCleanupKernel::new(
            Err(5),
            vec![Ok(empty_snapshot()), Ok(empty_snapshot())],
        ));

        assert_eq!(completion.status, CompletionStatus::TerminationUnverified);
        assert!(!completion.termination_verified);
        assert_eq!(completion.failure_stage, FailureStage::Cleanup);
        assert_eq!(completion.os_error, 5);
    }

    #[test]
    fn cleanup_query_failure_is_reported_as_unverified_with_only_its_numeric_error() {
        let completion = control_loss_completion(FakeCleanupKernel::new(Ok(()), vec![Err(87)]));

        assert_eq!(completion.status, CompletionStatus::TerminationUnverified);
        assert!(!completion.termination_verified);
        assert_eq!(completion.failure_stage, FailureStage::Cleanup);
        assert_eq!(completion.os_error, 87);
    }

    #[test]
    fn cleanup_verification_timeout_never_reports_success() {
        let completion = control_loss_completion(FakeCleanupKernel::new(
            Ok(()),
            vec![Ok(JobSnapshot {
                active_processes: 1,
                process_ids: vec![41],
            })],
        ));

        assert_eq!(completion.status, CompletionStatus::TerminationUnverified);
        assert!(!completion.termination_verified);
        assert_eq!(completion.failure_stage, FailureStage::Cleanup);
        assert_eq!(completion.active_processes, 1);
        assert_eq!(completion.process_ids, vec![41]);
        assert_eq!(completion.os_error, 0);
    }

    #[test]
    fn cleanup_output_overflow_wins_over_a_simultaneous_stream_disconnect() {
        let (sender, output) = mpsc::sync_channel(1);
        drop(sender);
        let mut streams = OutputStreamsState::default();
        let overflow = AtomicBool::new(true);
        let writer = ProtocolWriter::spawn();
        let mut output_bytes = 0;

        let result = drain_output_after_cleanup(
            &output,
            &mut streams,
            &overflow,
            &writer,
            &mut output_bytes,
            1_024,
            10,
        );

        assert!(matches!(result, OutputDrainResult::OutputLimit));
    }

    #[test]
    fn cleanup_output_read_failure_is_never_treated_as_clean_eof() {
        let (sender, output) = mpsc::sync_channel(1);
        sender.send(OutputEvent::ReadError(109)).unwrap();
        drop(sender);
        let mut streams = OutputStreamsState::default();
        let overflow = AtomicBool::new(false);
        let writer = ProtocolWriter::spawn();
        let mut output_bytes = 0;

        let result = drain_output_after_cleanup(
            &output,
            &mut streams,
            &overflow,
            &writer,
            &mut output_bytes,
            1_024,
            10,
        );

        assert!(matches!(result, OutputDrainResult::ReadFailed(109)));
    }

    #[test]
    fn output_reader_queues_clean_eof_after_its_final_bytes() {
        let (sender, output) = mpsc::sync_channel(4);
        let overflow = Arc::new(AtomicBool::new(false));
        spawn_output_reader(
            Cursor::new(b"final".to_vec()),
            OutputStream::Stdout,
            sender,
            Arc::clone(&overflow),
            Duration::ZERO,
        );

        assert!(matches!(
            output.recv_timeout(Duration::from_secs(1)),
            Ok(OutputEvent::Bytes(OutputStream::Stdout, bytes)) if bytes == b"final"
        ));
        assert!(matches!(
            output.recv_timeout(Duration::from_secs(1)),
            Ok(OutputEvent::Eof(OutputStream::Stdout))
        ));
        assert!(!overflow.load(Ordering::SeqCst));
        assert!(matches!(
            output.recv_timeout(Duration::from_millis(10)),
            Err(RecvTimeoutError::Disconnected)
        ));
    }

    #[test]
    fn output_reader_queues_read_failure_after_its_final_bytes() {
        let (sender, output) = mpsc::sync_channel(4);
        let overflow = Arc::new(AtomicBool::new(false));
        spawn_output_reader(
            BytesThenReadError {
                bytes: Cursor::new(b"final".to_vec()),
                os_error: 123,
            },
            OutputStream::Stderr,
            sender,
            Arc::clone(&overflow),
            Duration::ZERO,
        );

        assert!(matches!(
            output.recv_timeout(Duration::from_secs(1)),
            Ok(OutputEvent::Bytes(OutputStream::Stderr, bytes)) if bytes == b"final"
        ));
        assert!(matches!(
            output.recv_timeout(Duration::from_secs(1)),
            Ok(OutputEvent::ReadError(123))
        ));
        assert!(!overflow.load(Ordering::SeqCst));
    }

    #[test]
    fn control_reader_reports_transport_failure_instead_of_eof() {
        let (sender, control) = mpsc::sync_channel(1);
        read_control(
            BytesThenReadError {
                bytes: Cursor::new(Vec::new()),
                os_error: 995,
            },
            sender,
        );

        assert!(matches!(
            control.recv_timeout(Duration::from_secs(1)),
            Ok(ControlEvent::TransportError(995))
        ));
    }

    #[test]
    fn control_transport_failure_never_maps_to_verified_parent_eof() {
        let (control_sender, control) = mpsc::sync_channel(1);
        control_sender
            .send(ControlEvent::TransportError(995))
            .unwrap();
        let (stdin, _stdin_receiver) = mpsc::sync_channel(1);
        let mut stdin_closed = false;

        assert_eq!(
            consume_control(&control, &stdin, &mut stdin_closed),
            Some(StopReason::ControlTransportError(995))
        );
    }

    #[test]
    fn exit_code_query_failure_is_not_conflated_with_an_absent_exit_code() {
        let os_error = process_exit_code(NativeHandle(0)).unwrap_err();

        assert_ne!(os_error, 0);
    }

    fn control_loss_completion(mut kernel: FakeCleanupKernel) -> Completion {
        let (status, verification, failure_stage, os_error) = terminate_and_verify(
            &mut kernel,
            NativeHandle(1),
            10,
            CompletionStatus::Cancelled,
            FailureStage::None,
            0,
        );
        build_completion(status, verification, failure_stage, os_error, 42, None)
    }

    fn empty_snapshot() -> JobSnapshot {
        JobSnapshot {
            active_processes: 0,
            process_ids: Vec::new(),
        }
    }

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
