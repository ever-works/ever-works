//! Input into the captured display (FL-07 P2, FR-37 … FR-39, plan §6.2).
//!
//! The node forwards a controlling person's pointer, wheel, keys and text —
//! only while its view holds control, after its own blocked-shortcut check —
//! as `input` messages: the contracts' computer input frame plus the size of
//! the picture the coordinates are in. This module maps picture pixels to the
//! display (honouring its scale, FR-38), refuses the blocked shortcuts a second
//! time, and remembers every key and button it pressed so `releaseAll` lets
//! them all go (FR-39, U13).
//!
//! A helper that dies mid-control takes that memory with it (owner question
//! 14). So `releaseHeld` — sent by the node to a FRESH helper after one died
//! while it was controlled — and the helper's own panic hook let go of every
//! modifier key and mouse button the OS reports held ([`release_held`]),
//! whoever pressed it. They only ever release; nothing is pressed.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;

mod keys;
#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod win;
#[cfg(target_os = "linux")]
mod x11;

pub use crate::capture::DisplayRect;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Button {
    Left,
    Middle,
    Right,
}

/// One OS's way of moving the pointer, pressing buttons and keys and typing.
pub trait Injector {
    fn move_to(&mut self, x: f64, y: f64) -> Result<(), String>;
    fn button(&mut self, button: Button, down: bool) -> Result<(), String>;
    fn scroll(&mut self, dx: i32, dy: i32) -> Result<(), String>;
    /// A physical key by its `KeyboardEvent.code`; Err for a code this OS table lacks.
    fn key(&mut self, code: &str, down: bool) -> Result<(), String>;
    fn text(&mut self, text: &str) -> Result<(), String>;
    /// Which of [`RELEASABLE_MODIFIERS`] and the three buttons the OS reports held NOW,
    /// whoever pressed them (owner question 14).
    fn held(&mut self) -> Result<Held, String>;
}

/// The modifier keys a blind release lets go of. Never the system key: the helper refuses to press it.
pub const RELEASABLE_MODIFIERS: [&str; 6] = [
    "ShiftLeft",
    "ShiftRight",
    "ControlLeft",
    "ControlRight",
    "AltLeft",
    "AltRight",
];

/// What the OS reports held (see [`Injector::held`]).
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Held {
    pub keys: Vec<&'static str>,
    pub buttons: Vec<Button>,
}

/// Let go of every modifier key and mouse button the OS reports held — the
/// release a fresh helper does after one died mid-control. Answers how many
/// were released; Err only when the OS could not be asked.
pub fn release_held(injector: &mut dyn Injector) -> Result<usize, String> {
    let held = injector.held()?;
    let mut released = 0;
    for code in held.keys.iter().rev() {
        if injector.key(code, false).is_ok() {
            released += 1;
        }
    }
    for button in &held.buttons {
        if injector.button(*button, false).is_ok() {
            released += 1;
        }
    }
    Ok(released)
}

/// Set once this process has injected anything: its panic hook then releases what the OS reports held.
static INJECTED: AtomicBool = AtomicBool::new(false);

/// Note that this process has injected input (or is about to).
pub fn mark_injected() {
    INJECTED.store(true, Ordering::SeqCst);
}

/// Whether this process has injected input.
pub fn injected() -> bool {
    INJECTED.load(Ordering::SeqCst)
}

/// Open the injector for this session, or the reason input is unavailable.
#[cfg(target_os = "linux")]
pub fn open() -> Result<Box<dyn Injector>, &'static str> {
    x11::open()
}

#[cfg(windows)]
pub fn open() -> Result<Box<dyn Injector>, &'static str> {
    win::open()
}

#[cfg(target_os = "macos")]
pub fn open() -> Result<Box<dyn Injector>, &'static str> {
    mac::open()
}

#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
pub fn open() -> Result<Box<dyn Injector>, &'static str> {
    Err("kind-unsupported")
}

/// What would stop input, known WITHOUT opening anything (reported in `hello`).
/// Empty means "nothing known yet": the first input may still be refused when
/// the injector cannot be opened (no XTest, another desktop in front).
#[cfg(target_os = "macos")]
pub fn probe() -> Vec<&'static str> {
    mac::probe()
}

#[cfg(any(target_os = "linux", windows))]
pub fn probe() -> Vec<&'static str> {
    Vec::new()
}

#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
pub fn probe() -> Vec<&'static str> {
    vec!["kind-unsupported"]
}

/// One input as the node sends it (the contracts' input frame + the picture size).
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum InputFrame {
    #[serde(rename = "pointer")]
    Pointer {
        action: String,
        x: f64,
        y: f64,
        #[serde(default)]
        button: Option<String>,
        /// Carried for the wire's sake; the helper tracks its own pressed buttons.
        #[serde(default)]
        #[allow(dead_code)]
        buttons: Option<u32>,
        picture_width: f64,
        picture_height: f64,
    },
    #[serde(rename = "scroll")]
    Scroll {
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
        picture_width: f64,
        picture_height: f64,
    },
    #[serde(rename = "key")]
    Key {
        action: String,
        code: String,
        /// The layout's character; injection uses the physical `code` only.
        #[serde(default)]
        #[allow(dead_code)]
        key: Option<String>,
        modifiers: u32,
    },
    #[serde(rename = "text")]
    Text { text: String },
}

pub const MOD_ALT: u32 = 1;
pub const MOD_CTRL: u32 = 2;
pub const MOD_META: u32 = 4;

pub const MOD_SHIFT: u32 = 8;

/// The modifier bit a physical key holds while it is pressed (the contracts' `fleetDesktopModifierOfCode`).
pub fn modifier_of(code: &str) -> u32 {
    match code {
        "ControlLeft" | "ControlRight" => MOD_CTRL,
        "AltLeft" | "AltRight" => MOD_ALT,
        "MetaLeft" | "MetaRight" | "OSLeft" | "OSRight" => MOD_META,
        "ShiftLeft" | "ShiftRight" => MOD_SHIFT,
        _ => 0,
    }
}

/// The contracts' `COMPUTER_BLOCKED_SHORTCUTS`, refused here a second time.
pub fn is_blocked(code: &str, modifiers: u32) -> bool {
    let ctrl_or_meta = modifiers & MOD_CTRL != 0 || modifiers & MOD_META != 0;
    match code {
        "KeyC" | "KeyX" | "KeyV" | "KeyW" | "KeyT" | "KeyN" | "KeyQ" => ctrl_or_meta,
        "Tab" => ctrl_or_meta || modifiers & MOD_ALT != 0,
        "F4" => modifiers & MOD_ALT != 0,
        "Delete" => modifiers & MOD_CTRL != 0 && modifiers & MOD_ALT != 0,
        "MetaLeft" | "MetaRight" => true,
        _ => false,
    }
}

/// Picture pixels → the display's injection space (FR-38). None for a nonsense picture size.
pub fn map_point(
    rect: DisplayRect,
    x: f64,
    y: f64,
    picture_width: f64,
    picture_height: f64,
) -> Option<(f64, f64)> {
    // Written so a NaN anywhere refuses the point (`NaN >= 1.0` is false).
    let usable = picture_width >= 1.0 && picture_height >= 1.0 && x.is_finite() && y.is_finite();
    if !usable {
        return None;
    }
    let px = x.clamp(0.0, picture_width - 1.0) / picture_width;
    let py = y.clamp(0.0, picture_height - 1.0) / picture_height;
    Some((rect.x + px * rect.width, rect.y + py * rect.height))
}

/// What one input did.
#[derive(Debug, PartialEq, Eq)]
pub enum InputOutcome {
    Injected,
    Blocked,
    Refused(String),
}

/// The pressed keys and buttons of the controller, so they can all be released.
#[derive(Default)]
pub struct InputState {
    keys: BTreeSet<String>,
    buttons: BTreeSet<Button>,
}

fn button_of(name: Option<&str>) -> Option<Button> {
    match name {
        Some("left") => Some(Button::Left),
        Some("middle") => Some(Button::Middle),
        Some("right") => Some(Button::Right),
        _ => None,
    }
}

impl InputState {
    pub fn apply(
        &mut self,
        injector: &mut dyn Injector,
        rect: DisplayRect,
        frame: &InputFrame,
    ) -> InputOutcome {
        let result = match frame {
            InputFrame::Pointer {
                action,
                x,
                y,
                button,
                picture_width,
                picture_height,
                ..
            } => {
                let Some((dx, dy)) = map_point(rect, *x, *y, *picture_width, *picture_height)
                else {
                    return InputOutcome::Refused("picture size".into());
                };
                let moved = injector.move_to(dx, dy);
                match (action.as_str(), button_of(button.as_deref())) {
                    ("move", _) => moved,
                    ("down", Some(button)) => moved.and_then(|_| {
                        self.buttons.insert(button);
                        injector.button(button, true)
                    }),
                    ("up", Some(button)) => moved.and_then(|_| {
                        self.buttons.remove(&button);
                        injector.button(button, false)
                    }),
                    _ => Err("pointer action".into()),
                }
            }
            InputFrame::Scroll {
                x,
                y,
                dx,
                dy,
                picture_width,
                picture_height,
            } => {
                let Some((px, py)) = map_point(rect, *x, *y, *picture_width, *picture_height)
                else {
                    return InputOutcome::Refused("picture size".into());
                };
                let clamp = |v: f64| v.clamp(-10_000.0, 10_000.0).round() as i32;
                injector
                    .move_to(px, py)
                    .and_then(|_| injector.scroll(clamp(*dx), clamp(*dy)))
            }
            InputFrame::Key {
                action,
                code,
                modifiers,
                ..
            } => {
                // FR-37: the declared bits are never trusted alone — a shortcut split across
                // presses (Ctrl down, then V with no declared modifier) is refused too.
                if is_blocked(code, *modifiers | self.held_modifiers()) {
                    return InputOutcome::Blocked;
                }
                match action.as_str() {
                    "down" => injector.key(code, true).map(|_| {
                        self.keys.insert(code.clone());
                    }),
                    "up" => {
                        self.keys.remove(code);
                        injector.key(code, false)
                    }
                    _ => Err("key action".into()),
                }
            }
            InputFrame::Text { text } => {
                if text.chars().count() > 4096 {
                    return InputOutcome::Refused("text too long".into());
                }
                // Text typed while Ctrl, Alt or the system key is held would be a shortcut.
                if self.held_modifiers() & (MOD_CTRL | MOD_ALT | MOD_META) != 0 {
                    return InputOutcome::Blocked;
                }
                injector.text(text)
            }
        };
        match result {
            Ok(()) => InputOutcome::Injected,
            Err(message) => InputOutcome::Refused(message),
        }
    }

    /// The modifier bits of the keys this helper is holding down for the controller.
    fn held_modifiers(&self) -> u32 {
        self.keys
            .iter()
            .map(|code| modifier_of(code))
            .fold(0, |bits, bit| bits | bit)
    }

    /// Release every key and button pressed on the controller's behalf (FR-39). Never fails half-way.
    pub fn release_all(&mut self, injector: &mut dyn Injector) {
        for code in std::mem::take(&mut self.keys).into_iter().rev() {
            let _ = injector.key(&code, false);
        }
        for button in std::mem::take(&mut self.buttons) {
            let _ = injector.button(button, false);
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn pressed(&self) -> usize {
        self.keys.len() + self.buttons.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder {
        events: Vec<String>,
        /// What `held` reports (the OS's view in the real injectors).
        held: Held,
    }

    impl Injector for Recorder {
        fn move_to(&mut self, x: f64, y: f64) -> Result<(), String> {
            self.events.push(format!("move {x:.0},{y:.0}"));
            Ok(())
        }
        fn button(&mut self, button: Button, down: bool) -> Result<(), String> {
            self.events
                .push(format!("{button:?} {}", if down { "down" } else { "up" }));
            Ok(())
        }
        fn scroll(&mut self, dx: i32, dy: i32) -> Result<(), String> {
            self.events.push(format!("scroll {dx},{dy}"));
            Ok(())
        }
        fn key(&mut self, code: &str, down: bool) -> Result<(), String> {
            self.events
                .push(format!("{code} {}", if down { "down" } else { "up" }));
            Ok(())
        }
        fn text(&mut self, text: &str) -> Result<(), String> {
            self.events.push(format!("text {text}"));
            Ok(())
        }
        fn held(&mut self) -> Result<Held, String> {
            Ok(self.held.clone())
        }
    }

    const RETINA: DisplayRect = DisplayRect {
        x: 0.0,
        y: 0.0,
        width: 1512.0,
        height: 982.0,
    };

    fn frame(json: &str) -> InputFrame {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn maps_picture_pixels_onto_the_display() {
        // A 1280-wide picture of a 1512-point display: the middle stays the middle.
        assert_eq!(
            map_point(RETINA, 640.0, 415.5, 1280.0, 831.0),
            Some((756.0, 491.0))
        );
        let second = DisplayRect {
            x: 1920.0,
            y: 0.0,
            width: 2560.0,
            height: 1440.0,
        };
        assert_eq!(
            map_point(second, 0.0, 0.0, 1280.0, 720.0),
            Some((1920.0, 0.0))
        );
        assert_eq!(
            map_point(second, 5000.0, -3.0, 1280.0, 720.0).map(|(x, _)| x < 1920.0 + 2560.0),
            Some(true)
        );
        assert_eq!(map_point(second, 1.0, 1.0, 0.0, 720.0), None);
    }

    #[test]
    fn refuses_blocked_shortcuts_a_second_time() {
        let mut state = InputState::default();
        let mut recorder = Recorder::default();
        let copy = frame(r#"{"kind":"key","action":"down","code":"KeyC","key":"c","modifiers":2}"#);
        assert_eq!(
            state.apply(&mut recorder, RETINA, &copy),
            InputOutcome::Blocked
        );
        let super_key = frame(r#"{"kind":"key","action":"down","code":"MetaLeft","modifiers":0}"#);
        assert_eq!(
            state.apply(&mut recorder, RETINA, &super_key),
            InputOutcome::Blocked
        );
        assert!(recorder.events.is_empty());
        let plain =
            frame(r#"{"kind":"key","action":"down","code":"KeyC","key":"c","modifiers":0}"#);
        assert_eq!(
            state.apply(&mut recorder, RETINA, &plain),
            InputOutcome::Injected
        );
    }

    #[test]
    fn refuses_a_shortcut_split_across_presses_and_text_under_a_modifier() {
        let mut state = InputState::default();
        let mut recorder = Recorder::default();
        let ctrl = frame(r#"{"kind":"key","action":"down","code":"ControlLeft","modifiers":0}"#);
        assert_eq!(
            state.apply(&mut recorder, RETINA, &ctrl),
            InputOutcome::Injected
        );
        let paste = frame(r#"{"kind":"key","action":"down","code":"KeyV","modifiers":0}"#);
        assert_eq!(
            state.apply(&mut recorder, RETINA, &paste),
            InputOutcome::Blocked
        );
        let tab = frame(r#"{"kind":"text","text":"\t"}"#);
        assert_eq!(
            state.apply(&mut recorder, RETINA, &tab),
            InputOutcome::Blocked
        );
        let up = frame(r#"{"kind":"key","action":"up","code":"ControlLeft","modifiers":0}"#);
        assert_eq!(
            state.apply(&mut recorder, RETINA, &up),
            InputOutcome::Injected
        );
        assert_eq!(
            state.apply(&mut recorder, RETINA, &paste),
            InputOutcome::Injected
        );
        assert_eq!(modifier_of("ShiftRight"), MOD_SHIFT);
    }

    #[test]
    fn releases_every_pressed_key_and_button() {
        let mut state = InputState::default();
        let mut recorder = Recorder::default();
        for json in [
            r#"{"kind":"key","action":"down","code":"ShiftLeft","modifiers":8}"#,
            r#"{"kind":"key","action":"down","code":"KeyA","modifiers":8}"#,
            r#"{"kind":"pointer","action":"down","x":10,"y":10,"button":"left","pictureWidth":100,"pictureHeight":100}"#,
        ] {
            assert_eq!(
                state.apply(&mut recorder, RETINA, &frame(json)),
                InputOutcome::Injected
            );
        }
        assert_eq!(state.pressed(), 3);
        recorder.events.clear();
        state.release_all(&mut recorder);
        assert_eq!(state.pressed(), 0);
        assert!(recorder.events.contains(&"ShiftLeft up".to_string()));
        assert!(recorder.events.contains(&"KeyA up".to_string()));
        assert!(recorder.events.contains(&"Left up".to_string()));
    }

    #[test]
    fn scroll_moves_then_wheels_with_clamped_deltas() {
        let mut state = InputState::default();
        let mut recorder = Recorder::default();
        let wheel = frame(
            r#"{"kind":"scroll","x":50,"y":50,"dx":0,"dy":99999,"pictureWidth":100,"pictureHeight":100}"#,
        );
        assert_eq!(
            state.apply(&mut recorder, RETINA, &wheel),
            InputOutcome::Injected
        );
        assert_eq!(recorder.events.last().unwrap(), "scroll 0,10000");
    }

    #[test]
    fn a_blind_release_lets_go_of_what_the_os_reports_held_and_presses_nothing() {
        let mut recorder = Recorder {
            held: Held {
                keys: vec!["ControlLeft", "ShiftRight"],
                buttons: vec![Button::Left],
            },
            ..Recorder::default()
        };
        assert_eq!(release_held(&mut recorder), Ok(3));
        assert_eq!(
            recorder.events,
            vec!["ShiftRight up", "ControlLeft up", "Left up"]
        );
        assert!(recorder.events.iter().all(|event| event.ends_with(" up")));

        let mut idle = Recorder::default();
        assert_eq!(release_held(&mut idle), Ok(0));
        assert!(idle.events.is_empty());
    }

    #[test]
    fn the_releasable_modifiers_are_mapped_on_every_os_and_exclude_the_system_key() {
        for code in RELEASABLE_MODIFIERS {
            assert_ne!(modifier_of(code), 0, "{code} is a modifier");
            assert_ne!(modifier_of(code), MOD_META, "{code} is not the system key");
            assert!(keys::windows_vk(code).is_some(), "win {code}");
            assert!(keys::x11_keysym(code).is_some(), "x11 {code}");
            assert!(keys::mac_keycode(code).is_some(), "mac {code}");
        }
    }

    #[test]
    fn unknown_frames_do_not_parse() {
        assert!(serde_json::from_str::<InputFrame>(r#"{"kind":"exec","cmd":"rm"}"#).is_err());
    }
}
