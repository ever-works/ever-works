use ever_works_windows_job_launcher::{
    launcher::{
        CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessSpec,
        EXTENDED_STARTUPINFO_PRESENT, LaunchKernel, NativeHandle, PipeSet, PreparedProcess,
        SuspendedProcess, prepare_process,
    },
    protocol::{FailureStage, LaunchRequest, TestFailure},
};

#[derive(Clone, Debug, Eq, PartialEq)]
enum Event {
    CreateJob,
    SetKillOnClose(NativeHandle),
    CreatePipes,
    CreateSuspended,
    Assign,
    VerifyMembership,
    Resume,
    TerminateProcess,
    TerminateJob,
    WaitProcess,
    Close(NativeHandle),
}

struct FakeKernel {
    events: Vec<Event>,
    created_spec: Option<CreateProcessSpec>,
    assign_error: Option<u32>,
    membership: bool,
    resume_error: Option<u32>,
    terminate_process_error: Option<u32>,
    wait_process_exits: bool,
    wait_process_error: Option<u32>,
    entry_marker_written: bool,
}

impl Default for FakeKernel {
    fn default() -> Self {
        Self {
            events: Vec::new(),
            created_spec: None,
            assign_error: None,
            membership: true,
            resume_error: None,
            terminate_process_error: None,
            wait_process_exits: true,
            wait_process_error: None,
            entry_marker_written: false,
        }
    }
}

impl LaunchKernel for FakeKernel {
    fn create_job(&mut self) -> Result<NativeHandle, u32> {
        self.events.push(Event::CreateJob);
        Ok(NativeHandle(1))
    }

    fn set_kill_on_close(&mut self, job: NativeHandle) -> Result<(), u32> {
        self.events.push(Event::SetKillOnClose(job));
        Ok(())
    }

    fn create_private_pipes(&mut self) -> Result<PipeSet, u32> {
        self.events.push(Event::CreatePipes);
        Ok(PipeSet {
            child_stdin_read: NativeHandle(10),
            parent_stdin_write: NativeHandle(11),
            parent_stdout_read: NativeHandle(12),
            child_stdout_write: NativeHandle(13),
            parent_stderr_read: NativeHandle(14),
            child_stderr_write: NativeHandle(15),
        })
    }

    fn create_process_suspended(
        &mut self,
        spec: &CreateProcessSpec,
    ) -> Result<SuspendedProcess, u32> {
        self.events.push(Event::CreateSuspended);
        self.created_spec = Some(spec.clone());
        Ok(SuspendedProcess {
            process: NativeHandle(20),
            thread: NativeHandle(21),
            process_id: 4242,
        })
    }

    fn assign_process_to_job(
        &mut self,
        _job: NativeHandle,
        _process: NativeHandle,
    ) -> Result<(), u32> {
        self.events.push(Event::Assign);
        match self.assign_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn is_process_in_job(
        &mut self,
        _job: NativeHandle,
        _process: NativeHandle,
    ) -> Result<bool, u32> {
        self.events.push(Event::VerifyMembership);
        Ok(self.membership)
    }

    fn resume_thread(&mut self, _thread: NativeHandle) -> Result<(), u32> {
        self.events.push(Event::Resume);
        match self.resume_error {
            Some(error) => Err(error),
            None => {
                self.entry_marker_written = true;
                Ok(())
            }
        }
    }

    fn terminate_process(&mut self, _process: NativeHandle, _exit_code: u32) -> Result<(), u32> {
        self.events.push(Event::TerminateProcess);
        match self.terminate_process_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn terminate_job(&mut self, _job: NativeHandle, _exit_code: u32) -> Result<(), u32> {
        self.events.push(Event::TerminateJob);
        Ok(())
    }

    fn wait_process_exit(&mut self, _process: NativeHandle, _timeout_ms: u32) -> Result<bool, u32> {
        self.events.push(Event::WaitProcess);
        match self.wait_process_error {
            Some(error) => Err(error),
            None => Ok(self.wait_process_exits),
        }
    }

    fn close_handle(&mut self, handle: NativeHandle) {
        self.events.push(Event::Close(handle));
    }
}

#[test]
fn assigns_and_verifies_the_suspended_root_before_exactly_one_resume() {
    let mut kernel = FakeKernel::default();
    let prepared = prepare_process(&mut kernel, &request(TestFailure::None)).unwrap();

    assert_eq!(prepared.process_id, 4242);
    assert_eq!(
        kernel.events[..7],
        [
            Event::CreateJob,
            Event::SetKillOnClose(NativeHandle(1)),
            Event::CreatePipes,
            Event::CreateSuspended,
            Event::Assign,
            Event::VerifyMembership,
            Event::Resume,
        ]
    );
    assert_eq!(
        kernel
            .events
            .iter()
            .filter(|event| **event == Event::Resume)
            .count(),
        1
    );
    assert!(kernel.entry_marker_written);

    let spec = kernel.created_spec.unwrap();
    assert_eq!(
        spec.creation_flags,
        CREATE_SUSPENDED
            | CREATE_UNICODE_ENVIRONMENT
            | EXTENDED_STARTUPINFO_PRESENT
            | CREATE_NO_WINDOW
    );
    assert!(spec.inherit_handles);
    assert_eq!(
        spec.inherited_handles,
        vec![NativeHandle(10), NativeHandle(13), NativeHandle(15)]
    );
    assert_eq!(spec.application_path, r"C:\trusted\fixture.exe");
    assert_eq!(
        spec.command_line,
        r#""C:\trusted\fixture.exe" "two words" "quote\"value""#
    );
    assert_eq!(prepared.parent_stdin_write, NativeHandle(11));
    assert_eq!(prepared.parent_stdout_read, NativeHandle(12));
    assert_eq!(prepared.parent_stderr_read, NativeHandle(14));
}

#[test]
fn injected_assignment_failure_terminates_without_writing_the_entry_marker() {
    let mut kernel = FakeKernel::default();
    let failure = prepare_process(&mut kernel, &request(TestFailure::BeforeAssign)).unwrap_err();

    assert_eq!(failure.stage, FailureStage::AssignJob);
    assert!(!kernel.entry_marker_written);
    assert!(!kernel.events.contains(&Event::Resume));
    assert!(kernel.events.contains(&Event::TerminateProcess));
    assert!(kernel.events.contains(&Event::Close(NativeHandle(1))));
}

#[test]
fn injected_membership_failure_kills_the_assigned_job_before_resume() {
    let mut kernel = FakeKernel::default();
    let failure = prepare_process(
        &mut kernel,
        &request(TestFailure::AfterAssignBeforeMembership),
    )
    .unwrap_err();

    assert_eq!(failure.stage, FailureStage::VerifyMembership);
    assert!(kernel.events.contains(&Event::Assign));
    assert!(!kernel.events.contains(&Event::VerifyMembership));
    assert!(!kernel.events.contains(&Event::Resume));
    assert!(!kernel.entry_marker_written);
    assert!(kernel.events.contains(&Event::TerminateJob));
    assert!(kernel.events.contains(&Event::WaitProcess));
}

#[test]
fn reports_cleanup_failure_if_a_suspended_process_cannot_be_proven_dead() {
    let mut kernel = FakeKernel {
        terminate_process_error: Some(5),
        wait_process_exits: false,
        ..FakeKernel::default()
    };
    let failure = prepare_process(&mut kernel, &request(TestFailure::BeforeAssign)).unwrap_err();

    assert_eq!(failure.stage, FailureStage::Cleanup);
    assert_eq!(failure.os_error, 5);
    assert_eq!(
        kernel
            .events
            .iter()
            .filter(|event| **event == Event::TerminateProcess)
            .count(),
        2
    );
    assert_eq!(
        kernel
            .events
            .iter()
            .filter(|event| **event == Event::WaitProcess)
            .count(),
        2
    );
    assert!(!kernel.events.contains(&Event::Resume));
}

#[test]
fn nested_job_assignment_error_fails_closed_without_breakaway_or_resume() {
    let mut kernel = FakeKernel {
        assign_error: Some(5),
        ..FakeKernel::default()
    };
    let failure = prepare_process(&mut kernel, &request(TestFailure::None)).unwrap_err();

    assert_eq!(failure.stage, FailureStage::AssignJob);
    assert_eq!(failure.os_error, 5);
    assert!(!kernel.events.contains(&Event::Resume));
    assert!(!kernel.entry_marker_written);
    let spec = kernel.created_spec.unwrap();
    assert_eq!(
        spec.creation_flags & 0x0100_0000,
        0,
        "CREATE_BREAKAWAY_FROM_JOB must stay absent"
    );
}

#[test]
fn false_membership_is_a_pre_resume_failure_and_closes_the_job() {
    let mut kernel = FakeKernel {
        membership: false,
        ..FakeKernel::default()
    };
    let failure = prepare_process(&mut kernel, &request(TestFailure::None)).unwrap_err();

    assert_eq!(failure.stage, FailureStage::VerifyMembership);
    assert!(!kernel.entry_marker_written);
    assert!(!kernel.events.contains(&Event::Resume));
    assert!(kernel.events.contains(&Event::TerminateJob));
    assert!(kernel.events.contains(&Event::Close(NativeHandle(1))));
}

#[test]
fn resume_error_kills_the_assigned_job_and_never_retries_resume() {
    let mut kernel = FakeKernel {
        resume_error: Some(31),
        ..FakeKernel::default()
    };
    let failure = prepare_process(&mut kernel, &request(TestFailure::None)).unwrap_err();

    assert_eq!(failure.stage, FailureStage::Resume);
    assert_eq!(failure.os_error, 31);
    assert_eq!(
        kernel
            .events
            .iter()
            .filter(|event| **event == Event::Resume)
            .count(),
        1
    );
    assert!(!kernel.entry_marker_written);
    assert!(kernel.events.contains(&Event::TerminateJob));
}

#[test]
fn rejects_relative_applications_and_script_shims_before_allocating_a_job() {
    for application_path in [
        r"runner.exe",
        r"C:\trusted\runner.cmd",
        r"C:\trusted\runner.bat",
    ] {
        let mut launch_request = request(TestFailure::None);
        launch_request.application_path = application_path.to_owned();
        let mut kernel = FakeKernel::default();
        let failure = prepare_process(&mut kernel, &launch_request).unwrap_err();

        assert_eq!(failure.stage, FailureStage::CreateProcess);
        assert_eq!(failure.os_error, 87);
        assert!(kernel.events.is_empty(), "{application_path}");
    }
}

#[test]
fn rejects_relative_working_directories_before_allocating_a_job() {
    let mut launch_request = request(TestFailure::None);
    launch_request.working_directory = "workspace".to_owned();
    let mut kernel = FakeKernel::default();
    let failure = prepare_process(&mut kernel, &launch_request).unwrap_err();

    assert_eq!(failure.stage, FailureStage::CreateProcess);
    assert_eq!(failure.os_error, 87);
    assert!(kernel.events.is_empty());
}

#[test]
fn rejects_create_process_strings_larger_than_the_win32_wide_character_limit() {
    let mut launch_request = request(TestFailure::None);
    launch_request.arguments = vec!["x".repeat(32_767)];
    let mut kernel = FakeKernel::default();
    let failure = prepare_process(&mut kernel, &launch_request).unwrap_err();

    assert_eq!(failure.stage, FailureStage::CreateProcess);
    assert_eq!(failure.os_error, 87);
    assert!(kernel.events.is_empty());

    let mut launch_request = request(TestFailure::None);
    launch_request.environment = vec![("A".to_owned(), "x".repeat(32_767))];
    let mut kernel = FakeKernel::default();
    let failure = prepare_process(&mut kernel, &launch_request).unwrap_err();

    assert_eq!(failure.stage, FailureStage::CreateProcess);
    assert_eq!(failure.os_error, 87);
    assert!(kernel.events.is_empty());
}

fn request(test_failure: TestFailure) -> LaunchRequest {
    LaunchRequest {
        application_path: r"C:\trusted\fixture.exe".to_owned(),
        working_directory: r"C:\trusted\work".to_owned(),
        arguments: vec!["two words".to_owned(), "quote\"value".to_owned()],
        environment: vec![("FAKE_TOKEN".to_owned(), "fixture-only".to_owned())],
        timeout_ms: 30_000,
        cleanup_timeout_ms: 5_000,
        max_output_bytes: 1_048_576,
        test_failure,
    }
}

fn _assert_prepared_is_debug(_prepared: &PreparedProcess) {}
