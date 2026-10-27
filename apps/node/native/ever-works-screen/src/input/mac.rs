//! macOS input (FL-07 P2): Quartz events posted at the HID tap — the pointer in
//! global points (a drag while a button is held), buttons, the wheel (pixel
//! units), keys by virtual key code and text through a key event's Unicode
//! string. Needs the Accessibility permission; without it the helper reports
//! `permission-accessibility` and injects nothing (FR-22).

use std::ffi::c_void;

use super::keys::mac_keycode;
use super::{Button, Injector};

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightPostEventAccess() -> bool;
    fn CGEventCreateMouseEvent(source: *const c_void, kind: u32, point: CGPoint, button: u32) -> *mut c_void;
    fn CGEventCreateKeyboardEvent(source: *const c_void, keycode: u16, down: bool) -> *mut c_void;
    fn CGEventCreateScrollWheelEvent2(
        source: *const c_void,
        units: u32,
        wheel_count: u32,
        wheel1: i32,
        wheel2: i32,
        wheel3: i32,
    ) -> *mut c_void;
    fn CGEventKeyboardSetUnicodeString(event: *mut c_void, length: usize, string: *const u16);
    fn CGEventPost(tap: u32, event: *mut c_void);
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(object: *const c_void);
}

const HID_EVENT_TAP: u32 = 0;
const SCROLL_UNIT_PIXEL: u32 = 0;
const LEFT_DOWN: u32 = 1;
const LEFT_UP: u32 = 2;
const RIGHT_DOWN: u32 = 3;
const RIGHT_UP: u32 = 4;
const MOVED: u32 = 5;
const LEFT_DRAGGED: u32 = 6;
const RIGHT_DRAGGED: u32 = 7;
const OTHER_DOWN: u32 = 25;
const OTHER_UP: u32 = 26;
const OTHER_DRAGGED: u32 = 27;

struct QuartzInjector {
    at: CGPoint,
    held: Option<Button>,
}

/// `permission-accessibility` while macOS has not granted this executable input (FR-22).
/// The preflight only reads the grant; it never shows the system prompt.
pub fn probe() -> Vec<&'static str> {
    if unsafe { CGPreflightPostEventAccess() } {
        Vec::new()
    } else {
        vec!["permission-accessibility"]
    }
}

pub fn open() -> Result<Box<dyn Injector>, &'static str> {
    if !unsafe { CGPreflightPostEventAccess() } {
        return Err("permission-accessibility");
    }
    Ok(Box::new(QuartzInjector { at: CGPoint { x: 0.0, y: 0.0 }, held: None }))
}

fn post(event: *mut c_void) -> Result<(), String> {
    if event.is_null() {
        return Err("the input event could not be created".into());
    }
    unsafe {
        CGEventPost(HID_EVENT_TAP, event);
        CFRelease(event);
    }
    Ok(())
}

fn button_number(button: Button) -> u32 {
    match button {
        Button::Left => 0,
        Button::Right => 1,
        Button::Middle => 2,
    }
}

impl Injector for QuartzInjector {
    fn move_to(&mut self, x: f64, y: f64) -> Result<(), String> {
        self.at = CGPoint { x, y };
        let (kind, button) = match self.held {
            Some(Button::Left) => (LEFT_DRAGGED, 0),
            Some(Button::Right) => (RIGHT_DRAGGED, 1),
            Some(Button::Middle) => (OTHER_DRAGGED, 2),
            None => (MOVED, 0),
        };
        post(unsafe { CGEventCreateMouseEvent(std::ptr::null(), kind, self.at, button) })
    }

    fn button(&mut self, button: Button, down: bool) -> Result<(), String> {
        let kind = match (button, down) {
            (Button::Left, true) => LEFT_DOWN,
            (Button::Left, false) => LEFT_UP,
            (Button::Right, true) => RIGHT_DOWN,
            (Button::Right, false) => RIGHT_UP,
            (Button::Middle, true) => OTHER_DOWN,
            (Button::Middle, false) => OTHER_UP,
        };
        self.held = if down { Some(button) } else { None };
        post(unsafe { CGEventCreateMouseEvent(std::ptr::null(), kind, self.at, button_number(button)) })
    }

    fn scroll(&mut self, dx: i32, dy: i32) -> Result<(), String> {
        // Pixel units; up is positive on macOS, down is positive in a browser.
        post(unsafe { CGEventCreateScrollWheelEvent2(std::ptr::null(), SCROLL_UNIT_PIXEL, 2, -dy, -dx, 0) })
    }

    fn key(&mut self, code: &str, down: bool) -> Result<(), String> {
        let keycode = mac_keycode(code).ok_or_else(|| format!("no key {code}"))?;
        post(unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), keycode, down) })
    }

    fn text(&mut self, text: &str) -> Result<(), String> {
        let units: Vec<u16> = text.encode_utf16().collect();
        // Short runs per event: some applications drop very long Unicode strings.
        for chunk in units.chunks(16) {
            for down in [true, false] {
                let event = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), 0, down) };
                if event.is_null() {
                    return Err("the input event could not be created".into());
                }
                unsafe { CGEventKeyboardSetUnicodeString(event, chunk.len(), chunk.as_ptr()) };
                post(event)?;
            }
        }
        Ok(())
    }
}
