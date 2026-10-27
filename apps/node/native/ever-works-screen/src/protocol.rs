//! The node ↔ helper wire (FL-07 plan §3, CONTRACTS R-26).
//!
//! Over the helper's stdin / stdout (a same-user local channel — never a
//! network port), each message is
//!
//! ```text
//! [len u32 big-endian][type u8][payload: len - 1 bytes]
//! ```
//!
//! Control messages carry JSON; pictures carry bytes:
//!
//! | type | direction      | name           | payload                                          |
//! | ---- | -------------- | -------------- | ------------------------------------------------ |
//! | 0x01 | node → helper  | `start`        | JSON `{ display?, width, quality, maxFps, keyframeMs }` |
//! | 0x02 | node → helper  | `stop`         | —                                                |
//! | 0x03 | node → helper  | `setDisplay`   | JSON `{ display }`                               |
//! | 0x04 | node → helper  | `refresh`      | —                                                |
//! | 0x05 | node → helper  | `quality`      | JSON `{ width, quality, maxFps, keyframeMs }`    |
//! | 0x06 | node → helper  | `listDisplays` | —                                                |
//! | 0x10 | node → helper  | `input`        | JSON input frame + `pictureWidth`, `pictureHeight` |
//! | 0x11 | node → helper  | `releaseAll`   | — (let go of every pressed key and button)       |
//! | 0x12 | node → helper  | `releaseHeld`  | — (let go of every modifier and button the OS reports held; sent to a fresh helper after a crash during control) |
//! | 0x81 | helper → node  | `hello`        | JSON `{ protocol, version, platform, reasons, displays, inputReasons }` |
//! | 0x82 | helper → node  | `frame`        | `[width u16][height u16][JPEG]` — a keyframe     |
//! | 0x83 | helper → node  | `tiles`        | the contracts `TILES` payload, verbatim          |
//! | 0x84 | helper → node  | `displays`     | JSON `{ displays, fallback? }`                   |
//! | 0x85 | helper → node  | `error`        | JSON `{ code, message }`                         |
//! | 0x86 | helper → node  | `started`      | JSON `{ display, displays, fellBack }`           |
//! | 0x87 | helper → node  | `inputResult`  | JSON `{ outcome, code }` — only for an input that was not injected |
//!
//! Decoding never panics: every malformed message is an `Err`.

use std::io::{self, Read, Write};

use serde::Deserialize;

/// The protocol revision `hello` announces.
pub const PROTOCOL_VERSION: u32 = 1;

/// The largest message the helper accepts from the node (commands are tiny).
pub const MAX_INBOUND_BYTES: usize = 64 * 1024;

/// The largest message the helper sends (a keyframe or a tiles batch, each ≤ 512 KiB, plus headroom).
pub const MAX_OUTBOUND_BYTES: usize = 4 * 1024 * 1024;

pub const MSG_START: u8 = 0x01;
pub const MSG_STOP: u8 = 0x02;
pub const MSG_SET_DISPLAY: u8 = 0x03;
pub const MSG_REFRESH: u8 = 0x04;
pub const MSG_QUALITY: u8 = 0x05;
pub const MSG_LIST_DISPLAYS: u8 = 0x06;
pub const MSG_INPUT: u8 = 0x10;
pub const MSG_RELEASE_ALL: u8 = 0x11;
pub const MSG_RELEASE_HELD: u8 = 0x12;

pub const MSG_HELLO: u8 = 0x81;
pub const MSG_FRAME: u8 = 0x82;
pub const MSG_TILES: u8 = 0x83;
pub const MSG_DISPLAYS: u8 = 0x84;
pub const MSG_ERROR: u8 = 0x85;
pub const MSG_STARTED: u8 = 0x86;
pub const MSG_INPUT_RESULT: u8 = 0x87;

/// Bounds a stream setting must respect (the platform's presets live well inside them).
pub const MIN_WIDTH: u32 = 16;
pub const MAX_WIDTH: u32 = 8192;
pub const MAX_FPS: u32 = 30;
pub const MIN_KEYFRAME_MS: u32 = 500;
pub const MAX_KEYFRAME_MS: u32 = 60_000;

/// How a picture is produced: width in pixels, JPEG quality, pace, keyframe cadence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StreamSettings {
    pub width: u32,
    pub quality: u8,
    pub max_fps: u32,
    pub keyframe_ms: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartRequest {
    pub display: Option<String>,
    pub settings: StreamSettings,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Command {
    Start(StartRequest),
    Stop,
    SetDisplay(String),
    Refresh,
    Quality(StreamSettings),
    ListDisplays,
    /// One input (JSON: the contracts' input frame + the picture size), P2 control.
    Input(Vec<u8>),
    ReleaseAll,
    /// Owner question 14: release every modifier and button the OS reports held.
    ReleaseHeld,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DecodeError {
    UnknownType(u8),
    BadPayload(&'static str),
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::UnknownType(kind) => write!(f, "unknown message type 0x{kind:02x}"),
            DecodeError::BadPayload(what) => write!(f, "bad payload: {what}"),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartJson {
    #[serde(default)]
    display: Option<String>,
    width: u32,
    quality: u8,
    max_fps: u32,
    keyframe_ms: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QualityJson {
    width: u32,
    quality: u8,
    max_fps: u32,
    keyframe_ms: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DisplayJson {
    display: String,
}

/// A display id the helper accepts: `[A-Za-z0-9._:-]{1,64}` (the contracts' `isFleetDisplayId`).
pub fn is_display_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn settings(
    width: u32,
    quality: u8,
    max_fps: u32,
    keyframe_ms: u32,
) -> Result<StreamSettings, DecodeError> {
    if !(MIN_WIDTH..=MAX_WIDTH).contains(&width) {
        return Err(DecodeError::BadPayload("width"));
    }
    if !(1..=100).contains(&quality) {
        return Err(DecodeError::BadPayload("quality"));
    }
    if !(1..=MAX_FPS).contains(&max_fps) {
        return Err(DecodeError::BadPayload("maxFps"));
    }
    if !(MIN_KEYFRAME_MS..=MAX_KEYFRAME_MS).contains(&keyframe_ms) {
        return Err(DecodeError::BadPayload("keyframeMs"));
    }
    Ok(StreamSettings {
        width,
        quality,
        max_fps,
        keyframe_ms,
    })
}

/// Decode one node → helper message.
pub fn decode_command(kind: u8, payload: &[u8]) -> Result<Command, DecodeError> {
    match kind {
        MSG_START => {
            let json: StartJson =
                serde_json::from_slice(payload).map_err(|_| DecodeError::BadPayload("start"))?;
            if let Some(display) = &json.display
                && !is_display_id(display)
            {
                return Err(DecodeError::BadPayload("display"));
            }
            Ok(Command::Start(StartRequest {
                display: json.display,
                settings: settings(json.width, json.quality, json.max_fps, json.keyframe_ms)?,
            }))
        }
        MSG_STOP => empty(payload, Command::Stop),
        MSG_SET_DISPLAY => {
            let json: DisplayJson = serde_json::from_slice(payload)
                .map_err(|_| DecodeError::BadPayload("setDisplay"))?;
            if !is_display_id(&json.display) {
                return Err(DecodeError::BadPayload("display"));
            }
            Ok(Command::SetDisplay(json.display))
        }
        MSG_REFRESH => empty(payload, Command::Refresh),
        MSG_QUALITY => {
            let json: QualityJson =
                serde_json::from_slice(payload).map_err(|_| DecodeError::BadPayload("quality"))?;
            Ok(Command::Quality(settings(
                json.width,
                json.quality,
                json.max_fps,
                json.keyframe_ms,
            )?))
        }
        MSG_LIST_DISPLAYS => empty(payload, Command::ListDisplays),
        MSG_INPUT => {
            if payload.is_empty() || payload.len() > 16 * 1024 {
                return Err(DecodeError::BadPayload("input"));
            }
            Ok(Command::Input(payload.to_vec()))
        }
        MSG_RELEASE_ALL => empty(payload, Command::ReleaseAll),
        MSG_RELEASE_HELD => empty(payload, Command::ReleaseHeld),
        other => Err(DecodeError::UnknownType(other)),
    }
}

fn empty(payload: &[u8], command: Command) -> Result<Command, DecodeError> {
    if payload.is_empty() {
        Ok(command)
    } else {
        Err(DecodeError::BadPayload("unexpected payload"))
    }
}

/// Read one message: `Ok(None)` on a clean end of stream before a header.
pub fn read_message<R: Read>(
    reader: &mut R,
    max_bytes: usize,
) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut header = [0u8; 4];
    let mut filled = 0;
    while filled < header.len() {
        let read = reader.read(&mut header[filled..])?;
        if read == 0 {
            if filled == 0 {
                return Ok(None);
            }
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "truncated header",
            ));
        }
        filled += read;
    }
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "empty message"));
    }
    if length > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "message too large",
        ));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    let kind = body[0];
    body.remove(0);
    Ok(Some((kind, body)))
}

/// Write one message and flush it.
pub fn write_message<W: Write>(writer: &mut W, kind: u8, payload: &[u8]) -> io::Result<()> {
    let length = payload.len() + 1;
    if length > MAX_OUTBOUND_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "message too large",
        ));
    }
    writer.write_all(&(length as u32).to_be_bytes())?;
    writer.write_all(&[kind])?;
    writer.write_all(payload)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start_json(extra: &str) -> Vec<u8> {
        format!(r#"{{"width":1280,"quality":70,"maxFps":8,"keyframeMs":5000{extra}}}"#).into_bytes()
    }

    #[test]
    fn decodes_a_start() {
        let command = decode_command(MSG_START, &start_json(r#","display":"DP-1""#)).unwrap();
        assert_eq!(
            command,
            Command::Start(StartRequest {
                display: Some("DP-1".into()),
                settings: StreamSettings {
                    width: 1280,
                    quality: 70,
                    max_fps: 8,
                    keyframe_ms: 5000
                }
            })
        );
    }

    #[test]
    fn refuses_out_of_range_settings_and_unknown_fields() {
        let bad_width = br#"{"width":2,"quality":70,"maxFps":8,"keyframeMs":5000}"#;
        assert!(decode_command(MSG_START, bad_width).is_err());
        assert!(decode_command(MSG_START, &start_json(r#","display":"../x""#)).is_err());
        assert!(decode_command(MSG_START, &start_json(r#","shell":"rm""#)).is_err());
        let bad_fps = br#"{"width":800,"quality":45,"maxFps":0,"keyframeMs":2000}"#;
        assert!(decode_command(MSG_QUALITY, bad_fps).is_err());
    }

    #[test]
    fn unknown_type_is_an_error() {
        assert_eq!(
            decode_command(0x7f, &[]),
            Err(DecodeError::UnknownType(0x7f))
        );
        assert!(decode_command(MSG_STOP, &[1]).is_err());
    }

    #[test]
    fn decoding_garbage_never_panics() {
        let mut seed: u32 = 0x1234_5678;
        for _ in 0..2_000 {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            let len = (seed % 64) as usize;
            let bytes: Vec<u8> = (0..len)
                .map(|i| (seed.rotate_left(i as u32 % 31) & 0xff) as u8)
                .collect();
            let kind = (seed >> 24) as u8;
            let _ = decode_command(kind, &bytes);
            let _ = read_message(&mut &bytes[..], MAX_INBOUND_BYTES);
        }
    }

    #[test]
    fn round_trips_a_message() {
        let mut buffer = Vec::new();
        write_message(&mut buffer, MSG_REFRESH, &[]).unwrap();
        write_message(&mut buffer, MSG_FRAME, &[1, 2, 3]).unwrap();
        let mut reader = &buffer[..];
        assert_eq!(
            read_message(&mut reader, MAX_INBOUND_BYTES).unwrap(),
            Some((MSG_REFRESH, vec![]))
        );
        assert_eq!(
            read_message(&mut reader, MAX_INBOUND_BYTES).unwrap(),
            Some((MSG_FRAME, vec![1, 2, 3]))
        );
        assert_eq!(read_message(&mut reader, MAX_INBOUND_BYTES).unwrap(), None);
    }

    #[test]
    fn refuses_oversized_and_empty_messages() {
        let oversized = ((MAX_INBOUND_BYTES as u32) + 1).to_be_bytes();
        assert!(read_message(&mut &oversized[..], MAX_INBOUND_BYTES).is_err());
        let empty = 0u32.to_be_bytes();
        assert!(read_message(&mut &empty[..], MAX_INBOUND_BYTES).is_err());
        let truncated = [0u8, 0];
        assert!(read_message(&mut &truncated[..], MAX_INBOUND_BYTES).is_err());
    }

    #[test]
    fn carries_an_input_payload_and_bounds_it() {
        let text = br#"{"kind":"text","text":"a"}"#;
        assert_eq!(
            decode_command(MSG_INPUT, text).unwrap(),
            Command::Input(text.to_vec())
        );
        assert!(decode_command(MSG_INPUT, &[]).is_err());
        assert!(decode_command(MSG_INPUT, &vec![b'x'; 16 * 1024 + 1]).is_err());
        assert_eq!(
            decode_command(MSG_RELEASE_ALL, &[]).unwrap(),
            Command::ReleaseAll
        );
        assert_eq!(
            decode_command(MSG_RELEASE_HELD, &[]).unwrap(),
            Command::ReleaseHeld
        );
        assert!(decode_command(MSG_RELEASE_HELD, &[0]).is_err());
    }

    #[test]
    fn display_ids_match_the_contract() {
        assert!(is_display_id("DISPLAY1"));
        assert!(is_display_id("cg-69733382"));
        assert!(!is_display_id(r"\\.\DISPLAY1"));
        assert!(!is_display_id(""));
        assert!(!is_display_id(&"x".repeat(65)));
    }
}
