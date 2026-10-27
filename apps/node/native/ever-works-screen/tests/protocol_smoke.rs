//! The built helper, driven over its real stdin / stdout the way the node
//! drives it (FL-07, `apps/node/src/core/screen/helper/helper-process.ts`):
//! the same minimal environment, `hello` first, a malformed command answered
//! with `error`, an input refused while nothing streams, and an exit as soon
//! as stdin closes (the helper must never outlive the node).
//!
//! Nothing here needs a display or injects anything: on a headless runner
//! `hello` carries the reasons capture is unavailable, which is still a valid
//! `hello`, and the only input sent is refused before any injector is opened.

use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

const MSG_START: u8 = 0x01;
const MSG_INPUT: u8 = 0x10;
const MSG_RELEASE_HELD: u8 = 0x12;
const MSG_CONTROL_MARKER: u8 = 0x13;
const MSG_ADD_DISPLAY: u8 = 0x07;
const MSG_REMOVE_DISPLAY: u8 = 0x08;
const MSG_DISPLAY_CHANGE: u8 = 0x88;
const MSG_HELLO: u8 = 0x81;
const MSG_ERROR: u8 = 0x85;
const MSG_INPUT_RESULT: u8 = 0x87;

/// Longest wait for one message or for the exit; a hang fails instead of stalling the run.
const WAIT: Duration = Duration::from_secs(15);

/// The only variables the node hands the helper (`helperEnvironment`), when this process has them.
const NODE_PASSED_ENV: [&str; 6] = [
    "SystemRoot",
    "WINDIR",
    "DISPLAY",
    "XAUTHORITY",
    "XDG_SESSION_TYPE",
    "WAYLAND_DISPLAY",
];

fn helper() -> Command {
    Command::new(env!("CARGO_BIN_EXE_ever-works-screen"))
}

struct Running {
    child: Child,
    stdin: Option<ChildStdin>,
    messages: Receiver<(u8, Vec<u8>)>,
}

fn spawn() -> Running {
    let mut command = helper();
    command
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for key in NODE_PASSED_ENV {
        if let Ok(value) = std::env::var(key) {
            command.env(key, value);
        }
    }
    let mut child = command.spawn().expect("the helper starts");
    let stdin = child.stdin.take();
    let mut stdout = child.stdout.take().expect("piped stdout");
    let (sender, messages) = mpsc::channel();
    thread::spawn(move || {
        loop {
            let mut header = [0u8; 4];
            if stdout.read_exact(&mut header).is_err() {
                return;
            }
            let length = u32::from_be_bytes(header) as usize;
            let mut body = vec![0u8; length];
            if length == 0 || stdout.read_exact(&mut body).is_err() {
                return;
            }
            let kind = body.remove(0);
            if sender.send((kind, body)).is_err() {
                return;
            }
        }
    });
    Running {
        child,
        stdin,
        messages,
    }
}

impl Running {
    fn send(&mut self, kind: u8, payload: &[u8]) {
        let stdin = self.stdin.as_mut().expect("stdin still open");
        let mut message = ((payload.len() + 1) as u32).to_be_bytes().to_vec();
        message.push(kind);
        message.extend_from_slice(payload);
        stdin.write_all(&message).expect("write to the helper");
        stdin.flush().expect("flush to the helper");
    }

    fn next(&self) -> (u8, Value) {
        let (kind, payload) = self
            .messages
            .recv_timeout(WAIT)
            .expect("the helper answers in time");
        let value = serde_json::from_slice(&payload).expect("a JSON control message");
        (kind, value)
    }

    /// Close stdin and wait for the exit, killing a helper that stays.
    fn close_and_wait(mut self) -> (Option<i32>, Duration) {
        drop(self.stdin.take());
        let closed = Instant::now();
        loop {
            if let Some(status) = self.child.try_wait().expect("wait for the helper") {
                return (status.code(), closed.elapsed());
            }
            if closed.elapsed() > WAIT {
                let _ = self.child.kill();
                panic!("the helper outlived its stdin by {WAIT:?}");
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}

#[test]
fn says_hello_answers_errors_refuses_input_and_exits_on_stdin_close() {
    let mut helper = spawn();

    let (kind, hello) = helper.next();
    assert_eq!(kind, MSG_HELLO, "the first message is hello");
    assert_eq!(hello["protocol"], 1);
    assert_eq!(hello["version"], env!("CARGO_PKG_VERSION"));
    let platform = hello["platform"].as_str().expect("a platform");
    let expected = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    };
    assert_eq!(platform, expected);
    assert!(hello["reasons"].is_array());
    assert!(hello["inputReasons"].is_array());
    let features: Vec<&str> = hello["features"]
        .as_array()
        .expect("a feature list")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(features.contains(&"releaseHeld"));
    assert_eq!(
        features.contains(&"controlMarker"),
        cfg!(any(windows, target_os = "linux")),
        "the marker is offered where it can be drawn"
    );
    let displays = hello["displays"].as_array().expect("a display list");
    for display in displays {
        let id = display["id"].as_str().expect("a display id");
        assert!(
            !id.is_empty()
                && id.len() <= 64
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".:_-".contains(&b)),
            "display id {id:?} is not a contracts display id"
        );
    }
    assert!(
        displays.iter().filter(|d| d["primary"] == true).count() <= 1,
        "at most one primary display"
    );

    // The marker asked for with no stream running: nothing to show, nothing answered.
    helper.send(MSG_CONTROL_MARKER, br#"{"visible":true}"#);
    helper.send(MSG_CONTROL_MARKER, br#"{"visible":false}"#);

    // Out-of-range settings: answered `invalid`, and the helper keeps running.
    helper.send(
        MSG_START,
        br#"{"width":2,"quality":70,"maxFps":4,"keyframeMs":5000}"#,
    );
    let (kind, error) = helper.next();
    assert_eq!(kind, MSG_ERROR);
    assert_eq!(error["code"], "invalid");

    // An input with no stream running is refused by code, before any injector opens.
    helper.send(
        MSG_INPUT,
        br#"{"kind":"pointer","action":"move","x":1,"y":1,"pictureWidth":10,"pictureHeight":10}"#,
    );
    let (kind, result) = helper.next();
    assert_eq!(kind, MSG_INPUT_RESULT);
    assert_eq!(result["outcome"], "refused");
    assert_eq!(result["code"], "not-streaming");

    let (code, after) = helper.close_and_wait();
    assert_eq!(code, Some(0), "a clean exit when the node goes away");
    assert!(
        after < Duration::from_secs(5),
        "exited {after:?} after stdin closed"
    );
}

#[test]
fn a_fresh_helper_takes_release_held_first_and_answers_only_a_refusal() {
    let mut helper = spawn();
    let (kind, _) = helper.next();
    assert_eq!(kind, MSG_HELLO);

    // What a node sends a fresh helper after one died mid-control. It only ever releases:
    // nothing is answered when it was done (or nothing was held), a refusal names why not.
    helper.send(MSG_RELEASE_HELD, &[]);
    // A malformed start as a marker: its `error` shows every answer to releaseHeld has arrived.
    helper.send(
        MSG_START,
        br#"{"width":2,"quality":70,"maxFps":4,"keyframeMs":5000}"#,
    );
    let (kind, message) = helper.next();
    if kind == MSG_INPUT_RESULT {
        assert_eq!(message["outcome"], "refused");
        let code = message["code"].as_str().expect("a refusal code");
        assert!(
            [
                "no-display-session",
                "wayland-unsupported",
                "kind-unsupported",
                "permission-accessibility",
                "inject-failed"
            ]
            .contains(&code),
            "unexpected refusal {code}"
        );
        let (kind, _) = helper.next();
        assert_eq!(kind, MSG_ERROR);
    } else {
        assert_eq!(kind, MSG_ERROR, "only the marker's error follows");
        assert_eq!(message["code"], "invalid");
    }

    let (code, _) = helper.close_and_wait();
    assert_eq!(code, Some(0));
}

#[test]
fn refuses_virtual_display_requests_it_cannot_or_must_not_do_by_name() {
    // Safe on any machine: an off-list size is refused before the X server is asked, and a
    // display that does not exist cannot be removed.
    let mut helper = spawn();
    let (kind, _) = helper.next();
    assert_eq!(kind, MSG_HELLO);

    helper.send(
        MSG_ADD_DISPLAY,
        br#"{"name":"Desk","width":640,"height":480}"#,
    );
    let (kind, answer) = helper.next();
    assert_eq!(kind, MSG_DISPLAY_CHANGE);
    assert_eq!(answer["action"], "add");
    assert_eq!(answer["ok"], false);
    assert_eq!(answer["code"], "size-not-offered");
    assert!(answer["displays"].is_array());

    helper.send(MSG_REMOVE_DISPLAY, br#"{"display":"no-such-display"}"#);
    let (kind, answer) = helper.next();
    assert_eq!(kind, MSG_DISPLAY_CHANGE);
    assert_eq!(answer["action"], "remove");
    assert_eq!(answer["ok"], false);
    let code = answer["code"].as_str().expect("a refusal code");
    let expected: &[&str] = if cfg!(target_os = "linux") {
        &[
            "unsupported-session",
            "randr-unavailable",
            "unknown-display",
        ]
    } else {
        &["unsupported"]
    };
    assert!(expected.contains(&code), "unexpected refusal {code}");

    let (code, _) = helper.close_and_wait();
    assert_eq!(code, Some(0));
}

#[test]
fn prints_its_version_and_refuses_other_arguments() {
    let version = helper().arg("--version").output().expect("run --version");
    assert!(version.status.success());
    assert_eq!(
        String::from_utf8_lossy(&version.stdout).trim(),
        format!("ever-works-screen {}", env!("CARGO_PKG_VERSION"))
    );

    let other = helper()
        .arg("--listen")
        .stdin(Stdio::null())
        .output()
        .expect("run with an unknown argument");
    assert_eq!(other.status.code(), Some(2));
    assert!(
        other.stdout.is_empty(),
        "nothing on stdout for a refused start"
    );
}
