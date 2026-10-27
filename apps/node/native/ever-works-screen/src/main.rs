//! `ever-works-screen` — the Ever Works node's native screen helper (FL-07).
//!
//! The node starts this executable — and only after re-verifying it against
//! the owner's admission record, immediately before each start (FR-14) — and
//! talks to it over its stdin / stdout with the length-prefixed protocol in
//! `protocol.rs`. The helper:
//!
//! - announces itself with `hello` (version, platform, the reasons capture is
//!   unavailable, the displays);
//! - on `start`, captures one display at the stream's pace, publishing a JPEG
//!   keyframe on the keyframe cadence and the changed 64-pixel tiles in
//!   between (`tiles.rs`), never more than 512 KiB at a time;
//! - reports display changes within a few seconds and falls back to the
//!   primary display when the captured one goes away (U14);
//! - exits as soon as its stdin closes, so it can never outlive the node.
//!
//! It never listens on a network port, never opens a file, never reads the
//! clipboard and receives no credential (plan §11).
//!
//! Control (P2): `input` messages — sent by the node only while a view holds
//! control, after its own blocked-shortcut check — are injected into the
//! captured display (`input/`), with the blocked shortcuts refused a second
//! time. Every key and button pressed on a controller's behalf is released on
//! `releaseAll`, on `stop`, when the stream ends and when stdin closes (FR-39).
//! The injector is opened on the first input only, so a helper that is only
//! watched never asks the OS for input access. An input that was not injected
//! is answered `inputResult` with a code (never the typed text).
//!
//! After a crash during control (owner question 14): the node sends a FRESH
//! helper `releaseHeld` before anything else, which lets go of every modifier
//! key and mouse button the OS reports held; and a helper that panics after
//! injecting anything does the same from its panic hook before it aborts.
//!
//! While the node says a stream is in controlling mode (`controlMarker`, owner
//! question 10), the helper draws a border around the controlled display so
//! the person at the machine sees it is being driven (`marker/`).

mod capture;
mod input;
// macOS draws no marker yet: its geometry and colour go unused there.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
mod marker;
mod protocol;
mod scale;
mod tiles;

use std::io::{self, BufWriter, Write};
use std::process::ExitCode;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use capture::{Capturer, Display, DisplayRect};
use input::{Injector, InputFrame, InputOutcome, InputState};
use marker::Marker;
use protocol::{
    Command, MSG_DISPLAYS, MSG_ERROR, MSG_FRAME, MSG_HELLO, MSG_INPUT_RESULT, MSG_STARTED,
    MSG_TILES, PROTOCOL_VERSION, StartRequest, StreamSettings,
};
use tiles::RgbFrame;

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Displays are re-read this often while a stream runs (hot-plug within 3 s, FR-9).
const DISPLAY_CHECK_EVERY: Duration = Duration::from_secs(2);
/// Three failed pictures in a row end the stream; the node may start it again.
const MAX_FAILED_PICTURES: u32 = 3;
/// How long the idle helper waits for a command before looking again.
const IDLE_WAIT: Duration = Duration::from_secs(60);

enum Inbound {
    Command(Command),
    Invalid(String),
    Closed,
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        None => {}
        Some("--version") => {
            println!("ever-works-screen {VERSION}");
            return ExitCode::SUCCESS;
        }
        Some(_) => {
            eprintln!("ever-works-screen: started by the Ever Works node only (try --version)");
            return ExitCode::from(2);
        }
    }
    install_release_on_panic();
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("ever-works-screen: {error}");
            ExitCode::FAILURE
        }
    }
}

/// A panic (built `panic = abort`) must not leave a controller's keys held: after the
/// usual report, a helper that injected anything releases what the OS reports held.
fn install_release_on_panic() {
    let report = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        report(info);
        if input::injected()
            && let Ok(mut injector) = input::open()
        {
            let _ = input::release_held(injector.as_mut());
        }
    }));
}

fn spawn_reader() -> Receiver<Inbound> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        loop {
            match protocol::read_message(&mut input, protocol::MAX_INBOUND_BYTES) {
                Ok(Some((kind, payload))) => {
                    let message = match protocol::decode_command(kind, &payload) {
                        Ok(command) => Inbound::Command(command),
                        Err(error) => Inbound::Invalid(error.to_string()),
                    };
                    if sender.send(message).is_err() {
                        return;
                    }
                }
                Ok(None) | Err(_) => {
                    let _ = sender.send(Inbound::Closed);
                    return;
                }
            }
        }
    });
    receiver
}

struct Out<W: Write> {
    writer: W,
}

impl<W: Write> Out<W> {
    fn json(&mut self, kind: u8, value: &Value) -> io::Result<()> {
        let payload = serde_json::to_vec(value).map_err(io::Error::other)?;
        protocol::write_message(&mut self.writer, kind, &payload)
    }

    fn bytes(&mut self, kind: u8, payload: &[u8]) -> io::Result<()> {
        protocol::write_message(&mut self.writer, kind, payload)
    }

    fn error(&mut self, code: &str, message: &str) -> io::Result<()> {
        let message: String = message.chars().take(300).collect();
        self.json(MSG_ERROR, &json!({ "code": code, "message": message }))
    }
}

struct Session {
    display: String,
    settings: StreamSettings,
    previous: Option<RgbFrame>,
    next_at: Instant,
    last_keyframe: Option<Instant>,
    force_keyframe: bool,
    failures: u32,
}

impl Session {
    fn frame_interval(&self) -> Duration {
        Duration::from_millis(1000 / u64::from(self.settings.max_fps.max(1)))
    }
}

struct Helper<W: Write> {
    out: Out<W>,
    capturer: Option<Box<dyn Capturer>>,
    reasons: Vec<&'static str>,
    displays: Vec<Display>,
    session: Option<Session>,
    last_display_check: Instant,
    /// Opened on the first input (None until then, or after it failed to open).
    injector: Option<Box<dyn Injector>>,
    /// Why the injector could not be opened, once that was tried.
    injector_refused: Option<&'static str>,
    pressed: InputState,
    /// Owner question 10: the node asked for the marker (a stream in controlling mode).
    marker_wanted: bool,
    /// The marker, opened the first time it is wanted.
    marker: Option<Box<dyn Marker>>,
    /// The marker could not be opened here (it is not tried again).
    marker_failed: bool,
    /// Where the marker is shown now; None while it is hidden.
    marker_at: Option<DisplayRect>,
}

/// What this helper can do beyond protocol 1's first messages (`hello.features`).
fn features() -> Vec<&'static str> {
    let mut features = vec!["releaseHeld"];
    if marker::supported() {
        features.push("controlMarker");
    }
    features
}

fn run() -> io::Result<()> {
    let inbound = spawn_reader();
    let stdout = io::stdout();
    let opened = capture::open();
    let mut helper = Helper {
        out: Out {
            writer: BufWriter::new(stdout.lock()),
        },
        capturer: opened.capturer,
        reasons: opened.reasons,
        displays: Vec::new(),
        session: None,
        last_display_check: Instant::now(),
        injector: None,
        injector_refused: None,
        pressed: InputState::default(),
        marker_wanted: false,
        marker: None,
        marker_failed: false,
        marker_at: None,
    };
    helper.refresh_displays();
    helper.out.json(
        MSG_HELLO,
        &json!({
            "protocol": PROTOCOL_VERSION,
            "version": VERSION,
            "platform": capture::platform(),
            "reasons": helper.reasons,
            "displays": helper.displays,
            // P2: what would stop input, known without opening anything (macOS Accessibility).
            "inputReasons": input::probe(),
            // What the node may ask beyond the first messages (an older helper sends none).
            "features": features(),
        }),
    )?;
    loop {
        let wait = match &helper.session {
            Some(session) => session
                .next_at
                .saturating_duration_since(Instant::now())
                .min(DISPLAY_CHECK_EVERY),
            None => IDLE_WAIT,
        };
        match inbound.recv_timeout(wait) {
            Ok(Inbound::Command(command)) => helper.handle(command)?,
            Ok(Inbound::Invalid(message)) => helper.out.error("invalid", &message)?,
            // The node is gone (or closed our stdin): stop capturing at once and exit.
            Ok(Inbound::Closed) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
        helper.sync_marker(false);
        if helper.session.is_some() {
            if helper.last_display_check.elapsed() >= DISPLAY_CHECK_EVERY {
                helper.check_displays()?;
                helper.sync_marker(true);
            }
            let due = helper
                .session
                .as_ref()
                .map(|session| Instant::now() >= session.next_at)
                .unwrap_or(false);
            if due {
                helper.publish()?;
            }
        }
    }
    // Never leave a key or a button held on the machine (FR-39).
    helper.release_all();
    helper.session = None;
    helper.marker_wanted = false;
    helper.sync_marker(false);
    helper.marker = None;
    Ok(())
}

impl<W: Write> Helper<W> {
    fn refresh_displays(&mut self) {
        if let Some(capturer) = self.capturer.as_mut()
            && let Ok(displays) = capturer.displays()
        {
            self.displays = displays;
        }
    }

    fn unavailable_code(&self) -> &'static str {
        self.reasons.first().copied().unwrap_or("unsupported")
    }

    fn handle(&mut self, command: Command) -> io::Result<()> {
        match command {
            Command::Start(request) => self.start(request),
            Command::Stop => {
                self.release_all();
                self.session = None;
                Ok(())
            }
            Command::SetDisplay(id) => self.set_display(id),
            Command::Refresh => {
                if let Some(session) = self.session.as_mut() {
                    session.force_keyframe = true;
                    session.next_at = Instant::now();
                }
                Ok(())
            }
            Command::Quality(settings) => {
                if let Some(session) = self.session.as_mut() {
                    session.settings = settings;
                    session.previous = None;
                    session.force_keyframe = true;
                    session.next_at = Instant::now();
                }
                Ok(())
            }
            Command::ListDisplays => {
                self.refresh_displays();
                self.out
                    .json(MSG_DISPLAYS, &json!({ "displays": self.displays }))
            }
            Command::Input(payload) => self.input(&payload),
            Command::ReleaseAll => {
                self.release_all();
                Ok(())
            }
            Command::ReleaseHeld => self.release_held(),
            Command::ControlMarker(visible) => {
                self.marker_wanted = visible;
                Ok(())
            }
        }
    }

    /// Show the marker around the streamed display while it is wanted and a stream runs;
    /// hide it otherwise. `raise` puts a shown marker back on top (windows raised since).
    fn sync_marker(&mut self, raise: bool) {
        let target = if self.marker_wanted {
            let display = self.session.as_ref().map(|session| session.display.clone());
            display.and_then(|display| {
                self.capturer
                    .as_mut()
                    .and_then(|capturer| capturer.display_rect(&display))
            })
        } else {
            None
        };
        if target == self.marker_at {
            if raise
                && target.is_some()
                && let Some(marker) = self.marker.as_mut()
            {
                marker.raise();
            }
            return;
        }
        match target {
            Some(rect) => {
                if self.marker.is_none() && !self.marker_failed {
                    self.marker = marker::open();
                    self.marker_failed = self.marker.is_none();
                }
                if let Some(marker) = self.marker.as_mut() {
                    marker.show(rect);
                    self.marker_at = Some(rect);
                }
            }
            None => {
                if let Some(marker) = self.marker.as_mut() {
                    marker.hide();
                }
                self.marker_at = None;
            }
        }
    }

    /// The injector, opened on first use; the reason input is unavailable otherwise.
    fn open_injector(&mut self) -> Result<(), &'static str> {
        if self.injector.is_some() {
            return Ok(());
        }
        if let Some(reason) = self.injector_refused {
            return Err(reason);
        }
        match input::open() {
            Ok(injector) => {
                self.injector = Some(injector);
                Ok(())
            }
            Err(reason) => {
                self.injector_refused = Some(reason);
                Err(reason)
            }
        }
    }

    /// Owner question 14: let go of what this helper pressed, then of every modifier and
    /// button the OS still reports held (a previous helper may have died holding them).
    /// Only ever releases. Answered only when it could not be done.
    fn release_held(&mut self) -> io::Result<()> {
        if let Err(reason) = self.open_injector() {
            return self.input_result("refused", reason);
        }
        let Some(injector) = self.injector.as_mut() else {
            return Ok(());
        };
        self.pressed.release_all(injector.as_mut());
        match input::release_held(injector.as_mut()) {
            Ok(_) => Ok(()),
            Err(_) => self.input_result("refused", "inject-failed"),
        }
    }

    /// One input into the captured display; answered only when it was not injected.
    fn input(&mut self, payload: &[u8]) -> io::Result<()> {
        let Ok(frame) = serde_json::from_slice::<InputFrame>(payload) else {
            return self.input_result("refused", "invalid");
        };
        let Some(display) = self.session.as_ref().map(|session| session.display.clone()) else {
            return self.input_result("refused", "not-streaming");
        };
        let rect = self
            .capturer
            .as_mut()
            .and_then(|capturer| capturer.display_rect(&display));
        let Some(rect) = rect else {
            return self.input_result("refused", "unknown-display");
        };
        if let Err(reason) = self.open_injector() {
            return self.input_result("refused", reason);
        }
        let Some(injector) = self.injector.as_mut() else {
            return Ok(());
        };
        // From here on a panic releases what the OS reports held.
        input::mark_injected();
        match self.pressed.apply(injector.as_mut(), rect, &frame) {
            InputOutcome::Injected => Ok(()),
            InputOutcome::Blocked => self.input_result("blocked", "blocked-shortcut"),
            // The OS's own words are not passed on: keep the answer to a code.
            InputOutcome::Refused(_) => self.input_result("refused", "inject-failed"),
        }
    }

    fn input_result(&mut self, outcome: &str, code: &str) -> io::Result<()> {
        self.out.json(
            MSG_INPUT_RESULT,
            &json!({ "outcome": outcome, "code": code }),
        )
    }

    /// Let go of everything pressed on the controller's behalf. Never fails.
    fn release_all(&mut self) {
        if let Some(injector) = self.injector.as_mut() {
            self.pressed.release_all(injector.as_mut());
        }
    }

    fn start(&mut self, request: StartRequest) -> io::Result<()> {
        if self.capturer.is_none() {
            let code = self.unavailable_code();
            return self
                .out
                .error(code, "this session cannot be captured; see hello.reasons");
        }
        self.refresh_displays();
        let (display, fell_back) = match &request.display {
            Some(wanted) => match self.displays.iter().find(|display| &display.id == wanted) {
                Some(display) => (Some(display.clone()), false),
                None => (self.displays.first().cloned(), true),
            },
            None => (self.displays.first().cloned(), false),
        };
        let Some(display) = display else {
            return self.out.error("capture-failed", "no display to capture");
        };
        self.session = Some(Session {
            display: display.id.clone(),
            settings: request.settings,
            previous: None,
            next_at: Instant::now(),
            last_keyframe: None,
            force_keyframe: true,
            failures: 0,
        });
        self.last_display_check = Instant::now();
        self.out.json(
            MSG_STARTED,
            &json!({ "display": display, "displays": self.displays, "fellBack": fell_back }),
        )
    }

    fn set_display(&mut self, id: String) -> io::Result<()> {
        if self.session.is_none() {
            return self.out.error("invalid", "no stream is running");
        }
        if !self.displays.iter().any(|display| display.id == id) {
            self.refresh_displays();
        }
        let Some(display) = self
            .displays
            .iter()
            .find(|display| display.id == id)
            .cloned()
        else {
            return self
                .out
                .error("unknown-display", "that display is not attached");
        };
        if let Some(session) = self.session.as_mut() {
            session.display = display.id.clone();
            session.previous = None;
            session.force_keyframe = true;
            session.next_at = Instant::now();
        }
        self.out.json(
            MSG_STARTED,
            &json!({ "display": display, "displays": self.displays, "fellBack": false }),
        )
    }

    /// Re-read the displays; on a change tell the node, and fall back to the primary
    /// when the captured display went away (U14).
    fn check_displays(&mut self) -> io::Result<()> {
        self.last_display_check = Instant::now();
        let Some(capturer) = self.capturer.as_mut() else {
            return Ok(());
        };
        let Ok(current) = capturer.displays() else {
            return Ok(());
        };
        if current == self.displays {
            return Ok(());
        }
        self.displays = current;
        let mut fallback: Option<Display> = None;
        let mut lost_everything = false;
        if let Some(session) = self.session.as_mut()
            && !self
                .displays
                .iter()
                .any(|display| display.id == session.display)
        {
            match self.displays.first() {
                Some(primary) => {
                    session.display = primary.id.clone();
                    session.previous = None;
                    session.force_keyframe = true;
                    session.next_at = Instant::now();
                    fallback = Some(primary.clone());
                }
                None => lost_everything = true,
            }
        }
        if lost_everything {
            self.release_all();
            self.session = None;
            return self.out.error("capture-failed", "every display went away");
        }
        self.out.json(
            MSG_DISPLAYS,
            &json!({ "displays": self.displays, "fallback": fallback }),
        )
    }

    /// Take one picture and publish what changed: a keyframe when one is due, else the tiles.
    fn publish(&mut self) -> io::Result<()> {
        let now = Instant::now();
        let (Some(session), Some(capturer)) = (self.session.as_mut(), self.capturer.as_mut())
        else {
            return Ok(());
        };
        session.next_at = now + session.frame_interval();
        let picture = capturer
            .capture(&session.display)
            .and_then(|raw| scale::to_rgb_scaled(&raw, session.settings.width));
        let picture = match picture {
            Ok(picture) => {
                session.failures = 0;
                picture
            }
            Err(message) => {
                session.failures += 1;
                if session.failures >= MAX_FAILED_PICTURES {
                    self.session = None;
                    self.release_all();
                    return self.out.error("capture-failed", &message);
                }
                return Ok(());
            }
        };
        let keyframe_interval = Duration::from_millis(u64::from(session.settings.keyframe_ms));
        let size_changed = session
            .previous
            .as_ref()
            .map(|previous| previous.width != picture.width || previous.height != picture.height)
            .unwrap_or(true);
        let keyframe_due = session.force_keyframe
            || size_changed
            || session
                .last_keyframe
                .map(|at| now.duration_since(at) >= keyframe_interval)
                .unwrap_or(true);
        if !keyframe_due {
            let changed = match session.previous.as_ref() {
                Some(previous) => tiles::changed_tiles(previous, &picture),
                None => tiles::tile_grid(picture.width, picture.height),
            };
            if changed.is_empty() {
                return Ok(());
            }
            if !tiles::mostly_changed(changed.len(), picture.width, picture.height)
                && let Ok(payloads) = tiles::tiles_payloads(
                    &picture,
                    &changed,
                    session.settings.quality,
                    tiles::MAX_PUBLISH_BYTES,
                )
            {
                for payload in &payloads {
                    self.out.bytes(MSG_TILES, payload)?;
                }
                session.previous = Some(picture);
                return Ok(());
            }
            // Mostly changed, or a tile that would not fit: fall through to a keyframe.
        }
        match tiles::frame_payload(&picture, session.settings.quality, tiles::MAX_PUBLISH_BYTES) {
            Ok(payload) => {
                self.out.bytes(MSG_FRAME, &payload)?;
                session.previous = Some(picture);
                session.last_keyframe = Some(now);
                session.force_keyframe = false;
                Ok(())
            }
            Err(message) => self.out.error("capture-failed", &message),
        }
    }
}
