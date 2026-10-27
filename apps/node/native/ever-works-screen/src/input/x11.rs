//! Linux / X11 input (FL-07 P2): XTest fake input on the root window — the
//! pointer in root pixels, buttons 1–3 and the wheel (4–7), keys through the
//! server's current keyboard mapping (keysym → keycode), text one character at
//! a time where the mapping has its keysym (Shift added for the second column).

use std::collections::HashMap;

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, ConnectionExt as _, KEY_PRESS_EVENT,
    KEY_RELEASE_EVENT, MOTION_NOTIFY_EVENT, Window,
};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

use super::keys::x11_keysym;
use super::{Button, Injector};
use crate::capture::linux_session_reasons;

const SHIFT_L: u32 = 0xffe1;

struct XTestInjector {
    conn: RustConnection,
    root: Window,
    /// keysym → (keycode, needs Shift)
    keymap: HashMap<u32, (u8, bool)>,
}

pub fn open() -> Result<Box<dyn Injector>, &'static str> {
    let session_type = std::env::var("XDG_SESSION_TYPE").ok();
    let display = std::env::var("DISPLAY").ok();
    let wayland = std::env::var("WAYLAND_DISPLAY").ok();
    if let Some(reason) = linux_session_reasons(
        session_type.as_deref(),
        display.as_deref(),
        wayland.as_deref(),
    )
    .first()
    {
        return Err(*reason);
    }
    let (conn, screen_num) = RustConnection::connect(None).map_err(|_| "no-display-session")?;
    let root = conn
        .setup()
        .roots
        .get(screen_num)
        .map(|screen| screen.root)
        .ok_or("no-display-session")?;
    conn.xtest_get_version(2, 2)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .ok_or("kind-unsupported")?;
    let (min, max) = (conn.setup().min_keycode, conn.setup().max_keycode);
    let mapping = conn
        .get_keyboard_mapping(min, max.saturating_sub(min).saturating_add(1))
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .ok_or("no-display-session")?;
    let per = mapping.keysyms_per_keycode as usize;
    let mut keymap = HashMap::new();
    if per > 0 {
        for (index, chunk) in mapping.keysyms.chunks(per).enumerate() {
            let keycode = min.saturating_add(index as u8);
            for (column, keysym) in chunk.iter().take(2).enumerate() {
                if *keysym != 0 {
                    keymap.entry(*keysym).or_insert((keycode, column == 1));
                }
            }
        }
    }
    Ok(Box::new(XTestInjector { conn, root, keymap }))
}

impl XTestInjector {
    fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) -> Result<(), String> {
        self.conn
            .xtest_fake_input(kind, detail, 0, self.root, x, y, 0)
            .map_err(|error| error.to_string())?;
        self.conn.flush().map_err(|error| error.to_string())
    }

    fn keysym(&self, keysym: u32, down: bool) -> Result<(), String> {
        let (keycode, _) = *self
            .keymap
            .get(&keysym)
            .ok_or("no key for that on this keyboard")?;
        self.fake(
            if down {
                KEY_PRESS_EVENT
            } else {
                KEY_RELEASE_EVENT
            },
            keycode,
            0,
            0,
        )
    }
}

impl Injector for XTestInjector {
    fn move_to(&mut self, x: f64, y: f64) -> Result<(), String> {
        let clamp = |v: f64| v.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16;
        self.fake(MOTION_NOTIFY_EVENT, 0, clamp(x), clamp(y))
    }

    fn button(&mut self, button: Button, down: bool) -> Result<(), String> {
        let detail = match button {
            Button::Left => 1,
            Button::Middle => 2,
            Button::Right => 3,
        };
        self.fake(
            if down {
                BUTTON_PRESS_EVENT
            } else {
                BUTTON_RELEASE_EVENT
            },
            detail,
            0,
            0,
        )
    }

    fn scroll(&mut self, dx: i32, dy: i32) -> Result<(), String> {
        // One wheel click per 100 pixels of browser delta, at least one when it moved.
        let clicks = |delta: i32| {
            if delta == 0 {
                0
            } else {
                ((delta.abs() + 99) / 100).min(20)
            }
        };
        for (delta, negative, positive) in [(dy, 4u8, 5u8), (dx, 6u8, 7u8)] {
            let button = if delta < 0 { negative } else { positive };
            for _ in 0..clicks(delta) {
                self.fake(BUTTON_PRESS_EVENT, button, 0, 0)?;
                self.fake(BUTTON_RELEASE_EVENT, button, 0, 0)?;
            }
        }
        Ok(())
    }

    fn key(&mut self, code: &str, down: bool) -> Result<(), String> {
        let keysym = x11_keysym(code).ok_or_else(|| format!("no key {code}"))?;
        self.keysym(keysym, down)
    }

    fn text(&mut self, text: &str) -> Result<(), String> {
        for c in text.chars() {
            let cp = c as u32;
            let keysym = match c {
                '\n' => 0xff0d,
                '\t' => 0xff09,
                _ if cp <= 0xff => cp,
                _ => 0x0100_0000 | cp,
            };
            let Some(&(keycode, shifted)) = self.keymap.get(&keysym) else {
                // A character this keyboard cannot type is skipped, never a wrong one.
                continue;
            };
            if shifted {
                self.keysym(SHIFT_L, true)?;
            }
            self.fake(KEY_PRESS_EVENT, keycode, 0, 0)?;
            self.fake(KEY_RELEASE_EVENT, keycode, 0, 0)?;
            if shifted {
                self.keysym(SHIFT_L, false)?;
            }
        }
        Ok(())
    }
}
