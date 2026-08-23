use std::collections::HashSet;

pub const PROTOCOL_MAGIC: [u8; 4] = *b"EWJL";
pub const PROTOCOL_VERSION: u16 = 2;
pub const MAX_FRAME_SIZE: usize = 1_048_576;
const HEADER_SIZE: usize = 12;
const MAX_STRING_SIZE: usize = 32_768;
const MAX_ARGUMENTS: usize = 256;
const MAX_ENVIRONMENT_ENTRIES: usize = 512;

const KIND_LAUNCH: u16 = 1;
const KIND_STDIN: u16 = 2;
const KIND_CLOSE_STDIN: u16 = 3;
const KIND_CANCEL: u16 = 4;
const KIND_LAUNCHED: u16 = 0x8001;
const KIND_STDOUT: u16 = 0x8002;
const KIND_STDERR: u16 = 0x8003;
const KIND_COMPLETED: u16 = 0x8004;
const MAX_REPORTED_PROCESS_IDS: usize = 4_096;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[repr(u8)]
pub enum TestFailure {
    #[default]
    None = 0,
    BeforeAssign = 1,
    AfterAssignBeforeMembership = 2,
    AfterResumeAbort = 3,
}

impl TryFrom<u8> for TestFailure {
    type Error = ProtocolError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::None),
            1 => Ok(Self::BeforeAssign),
            2 => Ok(Self::AfterAssignBeforeMembership),
            3 => Ok(Self::AfterResumeAbort),
            _ => Err(ProtocolError::InvalidField),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaunchRequest {
    pub application_path: String,
    pub working_directory: String,
    pub arguments: Vec<String>,
    pub environment: Vec<(String, String)>,
    pub timeout_ms: u32,
    pub cleanup_timeout_ms: u32,
    pub max_output_bytes: u64,
    pub test_failure: TestFailure,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientMessage {
    Launch(LaunchRequest),
    Stdin(Vec<u8>),
    CloseStdin,
    Cancel,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum CompletionStatus {
    Exited = 0,
    Cancelled = 1,
    TimedOut = 2,
    OutputLimit = 3,
    LaunchFailed = 4,
    ProtocolError = 5,
    TerminationUnverified = 6,
}

impl TryFrom<u8> for CompletionStatus {
    type Error = ProtocolError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Exited),
            1 => Ok(Self::Cancelled),
            2 => Ok(Self::TimedOut),
            3 => Ok(Self::OutputLimit),
            4 => Ok(Self::LaunchFailed),
            5 => Ok(Self::ProtocolError),
            6 => Ok(Self::TerminationUnverified),
            _ => Err(ProtocolError::InvalidField),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u16)]
pub enum FailureStage {
    None = 0,
    CreateJob = 1,
    SetLimits = 2,
    CreatePipes = 3,
    CreateProcess = 4,
    AssignJob = 5,
    VerifyMembership = 6,
    Resume = 7,
    Runtime = 8,
    Cleanup = 9,
    Protocol = 10,
}

impl TryFrom<u16> for FailureStage {
    type Error = ProtocolError;

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::None),
            1 => Ok(Self::CreateJob),
            2 => Ok(Self::SetLimits),
            3 => Ok(Self::CreatePipes),
            4 => Ok(Self::CreateProcess),
            5 => Ok(Self::AssignJob),
            6 => Ok(Self::VerifyMembership),
            7 => Ok(Self::Resume),
            8 => Ok(Self::Runtime),
            9 => Ok(Self::Cleanup),
            10 => Ok(Self::Protocol),
            _ => Err(ProtocolError::InvalidField),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Completion {
    pub status: CompletionStatus,
    pub exit_code: Option<u32>,
    pub root_pid: u32,
    pub termination_verified: bool,
    pub active_processes: u32,
    pub process_ids: Vec<u32>,
    pub failure_stage: FailureStage,
    pub os_error: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerMessage {
    Launched { root_pid: u32 },
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Completed(Completion),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProtocolError {
    BadMagic,
    UnsupportedVersion,
    FrameTooLarge,
    UnknownMessage,
    InvalidField,
    TruncatedPayload,
}

#[derive(Debug)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
    max_frame_size: usize,
}

#[derive(Debug)]
pub struct ServerFrameDecoder {
    buffer: Vec<u8>,
    max_frame_size: usize,
}

impl Default for ServerFrameDecoder {
    fn default() -> Self {
        Self::new(MAX_FRAME_SIZE)
    }
}

impl ServerFrameDecoder {
    pub fn new(max_frame_size: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_frame_size: max_frame_size.min(MAX_FRAME_SIZE),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<ServerMessage>, ProtocolError> {
        if self.buffer.len().saturating_add(chunk.len())
            > self.max_frame_size.saturating_add(HEADER_SIZE)
        {
            return Err(ProtocolError::FrameTooLarge);
        }
        self.buffer.extend_from_slice(chunk);
        let mut messages = Vec::new();
        loop {
            if self.buffer.len() < HEADER_SIZE {
                break;
            }
            validate_header(&self.buffer)?;
            let kind = u16::from_le_bytes([self.buffer[6], self.buffer[7]]);
            let payload_len = u32::from_le_bytes([
                self.buffer[8],
                self.buffer[9],
                self.buffer[10],
                self.buffer[11],
            ]) as usize;
            if payload_len > self.max_frame_size {
                return Err(ProtocolError::FrameTooLarge);
            }
            let frame_len = HEADER_SIZE + payload_len;
            if self.buffer.len() < frame_len {
                break;
            }
            let payload = self.buffer[HEADER_SIZE..frame_len].to_vec();
            messages.push(decode_server_payload(kind, &payload)?);
            self.buffer.drain(..frame_len);
        }
        Ok(messages)
    }
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new(MAX_FRAME_SIZE)
    }
}

impl FrameDecoder {
    pub fn new(max_frame_size: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_frame_size: max_frame_size.min(MAX_FRAME_SIZE),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<ClientMessage>, ProtocolError> {
        if self.buffer.len().saturating_add(chunk.len())
            > self.max_frame_size.saturating_add(HEADER_SIZE)
        {
            return Err(ProtocolError::FrameTooLarge);
        }
        self.buffer.extend_from_slice(chunk);
        let mut messages = Vec::new();

        loop {
            if self.buffer.len() < HEADER_SIZE {
                break;
            }
            validate_header(&self.buffer)?;
            let kind = u16::from_le_bytes([self.buffer[6], self.buffer[7]]);
            let payload_len = u32::from_le_bytes([
                self.buffer[8],
                self.buffer[9],
                self.buffer[10],
                self.buffer[11],
            ]) as usize;
            if payload_len > self.max_frame_size {
                return Err(ProtocolError::FrameTooLarge);
            }
            let frame_len = HEADER_SIZE + payload_len;
            if self.buffer.len() < frame_len {
                break;
            }
            let payload = self.buffer[HEADER_SIZE..frame_len].to_vec();
            let message = decode_client_payload(kind, &payload)?;
            self.buffer.drain(..frame_len);
            messages.push(message);
        }

        Ok(messages)
    }

    pub fn has_pending_bytes(&self) -> bool {
        !self.buffer.is_empty()
    }
}

pub fn encode_client_message(message: &ClientMessage) -> Result<Vec<u8>, ProtocolError> {
    let (kind, payload) = match message {
        ClientMessage::Launch(request) => (KIND_LAUNCH, encode_launch_request(request)?),
        ClientMessage::Stdin(bytes) => {
            if bytes.len() > MAX_FRAME_SIZE {
                return Err(ProtocolError::FrameTooLarge);
            }
            (KIND_STDIN, bytes.clone())
        }
        ClientMessage::CloseStdin => (KIND_CLOSE_STDIN, Vec::new()),
        ClientMessage::Cancel => (KIND_CANCEL, Vec::new()),
    };
    encode_frame(kind, &payload)
}

pub fn encode_server_message(message: &ServerMessage) -> Result<Vec<u8>, ProtocolError> {
    let (kind, payload) = match message {
        ServerMessage::Launched { root_pid } => (KIND_LAUNCHED, root_pid.to_le_bytes().to_vec()),
        ServerMessage::Stdout(bytes) => (KIND_STDOUT, bytes.clone()),
        ServerMessage::Stderr(bytes) => (KIND_STDERR, bytes.clone()),
        ServerMessage::Completed(completion) => {
            if completion.process_ids.len() > MAX_REPORTED_PROCESS_IDS {
                return Err(ProtocolError::InvalidField);
            }
            let mut payload = Vec::with_capacity(25 + completion.process_ids.len() * 4);
            payload.push(completion.status as u8);
            match completion.exit_code {
                Some(exit_code) => {
                    payload.push(1);
                    payload.extend_from_slice(&exit_code.to_le_bytes());
                }
                None => {
                    payload.push(0);
                    payload.extend_from_slice(&0_u32.to_le_bytes());
                }
            }
            payload.extend_from_slice(&completion.root_pid.to_le_bytes());
            payload.push(u8::from(completion.termination_verified));
            payload.extend_from_slice(&completion.active_processes.to_le_bytes());
            put_u32(&mut payload, completion.process_ids.len())?;
            for process_id in &completion.process_ids {
                payload.extend_from_slice(&process_id.to_le_bytes());
            }
            payload.extend_from_slice(&(completion.failure_stage as u16).to_le_bytes());
            payload.extend_from_slice(&completion.os_error.to_le_bytes());
            (KIND_COMPLETED, payload)
        }
    };
    encode_frame(kind, &payload)
}

pub fn quote_windows_argument(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    let mut backslashes = 0_usize;
    for character in value.chars() {
        if character == '\\' {
            backslashes += 1;
            continue;
        }
        if character == '"' {
            quoted.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
            quoted.push('"');
        } else {
            quoted.extend(std::iter::repeat_n('\\', backslashes));
            quoted.push(character);
        }
        backslashes = 0;
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
    quoted.push('"');
    quoted
}

pub fn encode_environment_block(entries: &[(String, String)]) -> Result<Vec<u16>, ProtocolError> {
    validate_environment(entries)?;
    let mut sorted = entries.to_vec();
    sorted.sort_by_cached_key(|(name, _)| name.to_lowercase());
    let mut block = Vec::new();
    for (name, value) in sorted {
        block.extend(format!("{name}={value}").encode_utf16());
        block.push(0);
    }
    block.push(0);
    if entries.is_empty() {
        block.push(0);
    }
    Ok(block)
}

fn encode_frame(kind: u16, payload: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    if payload.len() > MAX_FRAME_SIZE {
        return Err(ProtocolError::FrameTooLarge);
    }
    let mut frame = Vec::with_capacity(HEADER_SIZE + payload.len());
    frame.extend_from_slice(&PROTOCOL_MAGIC);
    frame.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    frame.extend_from_slice(&kind.to_le_bytes());
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

fn encode_launch_request(request: &LaunchRequest) -> Result<Vec<u8>, ProtocolError> {
    validate_launch_request(request)?;
    let mut payload = Vec::new();
    put_string(&mut payload, &request.application_path)?;
    put_string(&mut payload, &request.working_directory)?;
    put_u32(&mut payload, request.arguments.len())?;
    for argument in &request.arguments {
        put_string(&mut payload, argument)?;
    }
    put_u32(&mut payload, request.environment.len())?;
    for (name, value) in &request.environment {
        put_string(&mut payload, name)?;
        put_string(&mut payload, value)?;
    }
    payload.extend_from_slice(&request.timeout_ms.to_le_bytes());
    payload.extend_from_slice(&request.cleanup_timeout_ms.to_le_bytes());
    payload.extend_from_slice(&request.max_output_bytes.to_le_bytes());
    payload.push(request.test_failure as u8);
    if payload.len() > MAX_FRAME_SIZE {
        return Err(ProtocolError::FrameTooLarge);
    }
    Ok(payload)
}

fn decode_client_payload(kind: u16, payload: &[u8]) -> Result<ClientMessage, ProtocolError> {
    match kind {
        KIND_LAUNCH => decode_launch_request(payload).map(ClientMessage::Launch),
        KIND_STDIN => Ok(ClientMessage::Stdin(payload.to_vec())),
        KIND_CLOSE_STDIN if payload.is_empty() => Ok(ClientMessage::CloseStdin),
        KIND_CANCEL if payload.is_empty() => Ok(ClientMessage::Cancel),
        KIND_CLOSE_STDIN | KIND_CANCEL => Err(ProtocolError::InvalidField),
        _ => Err(ProtocolError::UnknownMessage),
    }
}

fn decode_server_payload(kind: u16, payload: &[u8]) -> Result<ServerMessage, ProtocolError> {
    match kind {
        KIND_LAUNCHED => {
            let bytes: [u8; 4] = payload
                .try_into()
                .map_err(|_| ProtocolError::InvalidField)?;
            Ok(ServerMessage::Launched {
                root_pid: u32::from_le_bytes(bytes),
            })
        }
        KIND_STDOUT => Ok(ServerMessage::Stdout(payload.to_vec())),
        KIND_STDERR => Ok(ServerMessage::Stderr(payload.to_vec())),
        KIND_COMPLETED => {
            let mut cursor = Cursor::new(payload);
            let status = CompletionStatus::try_from(cursor.u8()?)?;
            let exit_code_present = cursor.u8()?;
            let encoded_exit_code = cursor.u32()?;
            let exit_code = match exit_code_present {
                0 if encoded_exit_code == 0 => None,
                0 => return Err(ProtocolError::InvalidField),
                1 => Some(encoded_exit_code),
                _ => return Err(ProtocolError::InvalidField),
            };
            let root_pid = cursor.u32()?;
            let termination_verified = match cursor.u8()? {
                0 => false,
                1 => true,
                _ => return Err(ProtocolError::InvalidField),
            };
            let active_processes = cursor.u32()?;
            let process_id_count = cursor.u32()? as usize;
            if process_id_count > MAX_REPORTED_PROCESS_IDS {
                return Err(ProtocolError::InvalidField);
            }
            let mut process_ids = Vec::with_capacity(process_id_count);
            for _ in 0..process_id_count {
                process_ids.push(cursor.u32()?);
            }
            let failure_stage = FailureStage::try_from(cursor.u16()?)?;
            let os_error = cursor.u32()?;
            if !cursor.is_finished() {
                return Err(ProtocolError::InvalidField);
            }
            Ok(ServerMessage::Completed(Completion {
                status,
                exit_code,
                root_pid,
                termination_verified,
                active_processes,
                process_ids,
                failure_stage,
                os_error,
            }))
        }
        _ => Err(ProtocolError::UnknownMessage),
    }
}

fn validate_header(buffer: &[u8]) -> Result<(), ProtocolError> {
    if buffer[..4] != PROTOCOL_MAGIC {
        return Err(ProtocolError::BadMagic);
    }
    let version = u16::from_le_bytes([buffer[4], buffer[5]]);
    if version != PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedVersion);
    }
    Ok(())
}

fn decode_launch_request(payload: &[u8]) -> Result<LaunchRequest, ProtocolError> {
    let mut cursor = Cursor::new(payload);
    let application_path = cursor.string()?;
    let working_directory = cursor.string()?;
    let argument_count = cursor.u32()? as usize;
    if argument_count > MAX_ARGUMENTS {
        return Err(ProtocolError::InvalidField);
    }
    let mut arguments = Vec::with_capacity(argument_count);
    for _ in 0..argument_count {
        arguments.push(cursor.string()?);
    }
    let environment_count = cursor.u32()? as usize;
    if environment_count > MAX_ENVIRONMENT_ENTRIES {
        return Err(ProtocolError::InvalidField);
    }
    let mut environment = Vec::with_capacity(environment_count);
    for _ in 0..environment_count {
        environment.push((cursor.string()?, cursor.string()?));
    }
    let request = LaunchRequest {
        application_path,
        working_directory,
        arguments,
        environment,
        timeout_ms: cursor.u32()?,
        cleanup_timeout_ms: cursor.u32()?,
        max_output_bytes: cursor.u64()?,
        test_failure: TestFailure::try_from(cursor.u8()?)?,
    };
    if !cursor.is_finished() {
        return Err(ProtocolError::InvalidField);
    }
    validate_launch_request(&request)?;
    Ok(request)
}

fn validate_launch_request(request: &LaunchRequest) -> Result<(), ProtocolError> {
    validate_string(&request.application_path)?;
    validate_string(&request.working_directory)?;
    if request.arguments.len() > MAX_ARGUMENTS {
        return Err(ProtocolError::InvalidField);
    }
    for argument in &request.arguments {
        validate_string(argument)?;
    }
    validate_environment(&request.environment)?;
    if request.timeout_ms == 0 || request.cleanup_timeout_ms == 0 || request.max_output_bytes == 0 {
        return Err(ProtocolError::InvalidField);
    }
    Ok(())
}

fn validate_environment(entries: &[(String, String)]) -> Result<(), ProtocolError> {
    if entries.len() > MAX_ENVIRONMENT_ENTRIES {
        return Err(ProtocolError::InvalidField);
    }
    let mut names = HashSet::with_capacity(entries.len());
    for (name, value) in entries {
        validate_string(name)?;
        validate_string(value)?;
        if name.is_empty() || name.contains('=') || !names.insert(name.to_lowercase()) {
            return Err(ProtocolError::InvalidField);
        }
    }
    Ok(())
}

fn validate_string(value: &str) -> Result<(), ProtocolError> {
    if value.contains('\0') || value.len() > MAX_STRING_SIZE {
        return Err(ProtocolError::InvalidField);
    }
    Ok(())
}

fn put_string(buffer: &mut Vec<u8>, value: &str) -> Result<(), ProtocolError> {
    validate_string(value)?;
    put_u32(buffer, value.len())?;
    buffer.extend_from_slice(value.as_bytes());
    Ok(())
}

fn put_u32(buffer: &mut Vec<u8>, value: usize) -> Result<(), ProtocolError> {
    let value = u32::try_from(value).map_err(|_| ProtocolError::FrameTooLarge)?;
    buffer.extend_from_slice(&value.to_le_bytes());
    Ok(())
}

struct Cursor<'a> {
    payload: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn new(payload: &'a [u8]) -> Self {
        Self { payload, offset: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], ProtocolError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(ProtocolError::TruncatedPayload)?;
        let bytes = self
            .payload
            .get(self.offset..end)
            .ok_or(ProtocolError::TruncatedPayload)?;
        self.offset = end;
        Ok(bytes)
    }

    fn u8(&mut self) -> Result<u8, ProtocolError> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, ProtocolError> {
        let bytes: [u8; 4] = self.take(4)?.try_into().expect("four-byte slice");
        Ok(u32::from_le_bytes(bytes))
    }

    fn u16(&mut self) -> Result<u16, ProtocolError> {
        let bytes: [u8; 2] = self.take(2)?.try_into().expect("two-byte slice");
        Ok(u16::from_le_bytes(bytes))
    }

    fn u64(&mut self) -> Result<u64, ProtocolError> {
        let bytes: [u8; 8] = self.take(8)?.try_into().expect("eight-byte slice");
        Ok(u64::from_le_bytes(bytes))
    }

    fn string(&mut self) -> Result<String, ProtocolError> {
        let length = self.u32()? as usize;
        if length > MAX_STRING_SIZE {
            return Err(ProtocolError::InvalidField);
        }
        String::from_utf8(self.take(length)?.to_vec()).map_err(|_| ProtocolError::InvalidField)
    }

    fn is_finished(&self) -> bool {
        self.offset == self.payload.len()
    }
}
