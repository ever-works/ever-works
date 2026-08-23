use std::{
    ffi::c_void,
    mem::{offset_of, size_of},
    ptr::{null, null_mut},
    thread,
    time::{Duration, Instant},
};

use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_MORE_DATA, GetLastError, HANDLE, HANDLE_FLAG_INHERIT,
        SetHandleInformation,
    },
    Security::SECURITY_ATTRIBUTES,
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
            JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
            TerminateJobObject,
        },
        Pipes::CreatePipe,
        Threading::{
            CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, ResumeThread,
            STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute,
        },
    },
};

use crate::{
    launcher::{CreateProcessSpec, LaunchKernel, NativeHandle, PipeSet, SuspendedProcess},
    runtime::{JobQueryKernel, JobSnapshot},
};

const MAX_JOB_PROCESS_IDS: usize = 4_096;
const ERROR_INVALID_DATA: u32 = 13;

pub struct WindowsKernel {
    started: Instant,
}

impl WindowsKernel {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
        }
    }
}

impl Default for WindowsKernel {
    fn default() -> Self {
        Self::new()
    }
}

impl LaunchKernel for WindowsKernel {
    fn create_job(&mut self) -> Result<NativeHandle, u32> {
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(last_error());
        }
        if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
            let error = last_error();
            unsafe { CloseHandle(handle) };
            return Err(error);
        }
        Ok(native(handle))
    }

    fn set_kill_on_close(&mut self, job: NativeHandle) -> Result<(), u32> {
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let result = unsafe {
            SetInformationJobObject(
                handle(job),
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        bool_result(result)
    }

    fn create_private_pipes(&mut self) -> Result<PipeSet, u32> {
        let (child_stdin_read, parent_stdin_write) = create_pipe_pair(PipeParentEnd::Write)?;
        let (parent_stdout_read, child_stdout_write) = match create_pipe_pair(PipeParentEnd::Read) {
            Ok(pair) => pair,
            Err(error) => {
                close_raw(child_stdin_read);
                close_raw(parent_stdin_write);
                return Err(error);
            }
        };
        let (parent_stderr_read, child_stderr_write) = match create_pipe_pair(PipeParentEnd::Read) {
            Ok(pair) => pair,
            Err(error) => {
                for handle in [
                    child_stdin_read,
                    parent_stdin_write,
                    parent_stdout_read,
                    child_stdout_write,
                ] {
                    close_raw(handle);
                }
                return Err(error);
            }
        };
        Ok(PipeSet {
            child_stdin_read: native(child_stdin_read),
            parent_stdin_write: native(parent_stdin_write),
            parent_stdout_read: native(parent_stdout_read),
            child_stdout_write: native(child_stdout_write),
            parent_stderr_read: native(parent_stderr_read),
            child_stderr_write: native(child_stderr_write),
        })
    }

    fn create_process_suspended(
        &mut self,
        spec: &CreateProcessSpec,
    ) -> Result<SuspendedProcess, u32> {
        let application = wide_nul(&spec.application_path);
        let working_directory = wide_nul(&spec.working_directory);
        let mut command_line = wide_nul(&spec.command_line);
        let inherited_handles: Vec<HANDLE> =
            spec.inherited_handles.iter().copied().map(handle).collect();

        let mut attribute_bytes = 0_usize;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_bytes);
        }
        if attribute_bytes == 0 {
            return Err(last_error());
        }
        let word_count = attribute_bytes.div_ceil(size_of::<usize>());
        let mut attribute_storage = vec![0_usize; word_count];
        let attribute_list = attribute_storage.as_mut_ptr().cast::<c_void>();
        if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_bytes) }
            == 0
        {
            return Err(last_error());
        }
        let updated = unsafe {
            UpdateProcThreadAttribute(
                attribute_list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                inherited_handles.as_ptr().cast::<c_void>(),
                std::mem::size_of_val(inherited_handles.as_slice()),
                null_mut(),
                null(),
            )
        };
        if updated == 0 {
            let error = last_error();
            unsafe { DeleteProcThreadAttributeList(attribute_list) };
            return Err(error);
        }

        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handle(spec.stdin_handle);
        startup.StartupInfo.hStdOutput = handle(spec.stdout_handle);
        startup.StartupInfo.hStdError = handle(spec.stderr_handle);
        startup.lpAttributeList = attribute_list;
        let mut process = PROCESS_INFORMATION::default();
        let created = unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                spec.inherit_handles as i32,
                spec.creation_flags,
                spec.environment_block.as_ptr().cast::<c_void>(),
                working_directory.as_ptr(),
                std::ptr::addr_of!(startup.StartupInfo),
                &mut process,
            )
        };
        let create_error = (created == 0).then(last_error);
        unsafe { DeleteProcThreadAttributeList(attribute_list) };
        if let Some(error) = create_error {
            return Err(error);
        }
        Ok(SuspendedProcess {
            process: native(process.hProcess),
            thread: native(process.hThread),
            process_id: process.dwProcessId,
        })
    }

    fn assign_process_to_job(
        &mut self,
        job: NativeHandle,
        process: NativeHandle,
    ) -> Result<(), u32> {
        bool_result(unsafe { AssignProcessToJobObject(handle(job), handle(process)) })
    }

    fn is_process_in_job(&mut self, job: NativeHandle, process: NativeHandle) -> Result<bool, u32> {
        let mut is_member = 0_i32;
        let result = unsafe { IsProcessInJob(handle(process), handle(job), &mut is_member) };
        if result == 0 {
            Err(last_error())
        } else {
            Ok(is_member != 0)
        }
    }

    fn resume_thread(&mut self, thread: NativeHandle) -> Result<(), u32> {
        if unsafe { ResumeThread(handle(thread)) } == u32::MAX {
            Err(last_error())
        } else {
            Ok(())
        }
    }

    fn terminate_process(&mut self, process: NativeHandle, exit_code: u32) -> Result<(), u32> {
        bool_result(unsafe { TerminateProcess(handle(process), exit_code) })
    }

    fn terminate_job(&mut self, job: NativeHandle, exit_code: u32) -> Result<(), u32> {
        bool_result(unsafe { TerminateJobObject(handle(job), exit_code) })
    }

    fn wait_process_exit(&mut self, process: NativeHandle, timeout_ms: u32) -> Result<bool, u32> {
        match unsafe {
            windows_sys::Win32::System::Threading::WaitForSingleObject(handle(process), timeout_ms)
        } {
            windows_sys::Win32::Foundation::WAIT_OBJECT_0 => Ok(true),
            windows_sys::Win32::Foundation::WAIT_TIMEOUT => Ok(false),
            _ => Err(last_error()),
        }
    }

    fn close_handle(&mut self, native_handle: NativeHandle) {
        close_raw(handle(native_handle));
    }
}

impl JobQueryKernel for WindowsKernel {
    fn monotonic_millis(&self) -> u64 {
        self.started
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }

    fn wait_millis(&mut self, milliseconds: u32) {
        thread::sleep(Duration::from_millis(u64::from(milliseconds)));
    }

    fn query_job(&mut self, job: NativeHandle) -> Result<JobSnapshot, u32> {
        let active_processes = query_active_processes(handle(job))?;
        let process_ids = query_process_ids(handle(job))?;
        Ok(JobSnapshot {
            active_processes,
            process_ids,
        })
    }
}

enum PipeParentEnd {
    Read,
    Write,
}

fn create_pipe_pair(parent_end: PipeParentEnd) -> Result<(HANDLE, HANDLE), u32> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let mut read = null_mut();
    let mut write = null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return Err(last_error());
    }
    let parent = match parent_end {
        PipeParentEnd::Read => read,
        PipeParentEnd::Write => write,
    };
    if unsafe { SetHandleInformation(parent, HANDLE_FLAG_INHERIT, 0) } == 0 {
        let error = last_error();
        close_raw(read);
        close_raw(write);
        return Err(error);
    }
    Ok((read, write))
}

fn query_active_processes(job: HANDLE) -> Result<u32, u32> {
    let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    let result = unsafe {
        QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            std::ptr::addr_of_mut!(accounting).cast::<c_void>(),
            size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            null_mut(),
        )
    };
    bool_result(result).map(|()| accounting.ActiveProcesses)
}

fn query_process_ids(job: HANDLE) -> Result<Vec<u32>, u32> {
    let header_size = offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList);
    let mut capacity = 16_usize;
    loop {
        let bytes = header_size + capacity * size_of::<usize>();
        let mut storage = vec![0_usize; bytes.div_ceil(size_of::<usize>())];
        let buffer = storage.as_mut_ptr().cast::<u8>();
        let result = unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicProcessIdList,
                buffer.cast::<c_void>(),
                bytes as u32,
                null_mut(),
            )
        };
        let header = buffer.cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
        let assigned = unsafe { (*header).NumberOfAssignedProcesses as usize };
        let reported = unsafe { (*header).NumberOfProcessIdsInList as usize };
        if result != 0 {
            if reported > capacity || assigned > MAX_JOB_PROCESS_IDS {
                return Err(ERROR_INVALID_DATA);
            }
            let ids = unsafe { buffer.add(header_size).cast::<usize>() };
            let mut process_ids = Vec::with_capacity(reported);
            for index in 0..reported {
                let process_id = unsafe { ids.add(index).read_unaligned() };
                process_ids.push(u32::try_from(process_id).map_err(|_| ERROR_INVALID_DATA)?);
            }
            return Ok(process_ids);
        }
        let error = last_error();
        if error != ERROR_MORE_DATA || capacity >= MAX_JOB_PROCESS_IDS {
            return Err(error);
        }
        capacity = assigned
            .max(capacity.saturating_mul(2))
            .min(MAX_JOB_PROCESS_IDS);
    }
}

fn wide_nul(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn bool_result(result: i32) -> Result<(), u32> {
    if result == 0 {
        Err(last_error())
    } else {
        Ok(())
    }
}

fn last_error() -> u32 {
    unsafe { GetLastError() }
}

fn native(handle: HANDLE) -> NativeHandle {
    NativeHandle(handle as usize)
}

fn handle(native_handle: NativeHandle) -> HANDLE {
    native_handle.0 as HANDLE
}

fn close_raw(handle: HANDLE) {
    if !handle.is_null() {
        unsafe { CloseHandle(handle) };
    }
}
