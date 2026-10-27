//! Windows input (FL-07 P2): `SetCursorPos` in physical pixels (the process is
//! per-monitor DPI aware), `SendInput` for buttons, the wheel, keys (virtual-key
//! codes, extended flag where the key needs it) and text (`KEYEVENTF_UNICODE`,
//! one UTF-16 unit at a time). Input never reaches the secure desktop: Windows
//! refuses it there, which is the point.

use std::mem::size_of;

use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT, SendInput,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SetCursorPos;

use super::keys::windows_vk;
use super::{Button, Injector};

/// One wheel notch.
const WHEEL_DELTA: i32 = 120;

struct SendInputInjector;

pub fn open() -> Result<Box<dyn Injector>, &'static str> {
    Ok(Box::new(SendInputInjector))
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err("Windows refused the input (another desktop is in front?)".into())
    }
}

fn mouse(flags: u32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: data as _,
                dwFlags: flags as _,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn keyboard(vk: u16, scan: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk as _,
                wScan: scan,
                dwFlags: flags as _,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

impl Injector for SendInputInjector {
    fn move_to(&mut self, x: f64, y: f64) -> Result<(), String> {
        let ok = unsafe { SetCursorPos(x.round() as i32, y.round() as i32) };
        if ok == 0 { Err("the pointer could not be moved".into()) } else { Ok(()) }
    }

    fn button(&mut self, button: Button, down: bool) -> Result<(), String> {
        let flags = match (button, down) {
            (Button::Left, true) => MOUSEEVENTF_LEFTDOWN,
            (Button::Left, false) => MOUSEEVENTF_LEFTUP,
            (Button::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
            (Button::Middle, false) => MOUSEEVENTF_MIDDLEUP,
            (Button::Right, true) => MOUSEEVENTF_RIGHTDOWN,
            (Button::Right, false) => MOUSEEVENTF_RIGHTUP,
        };
        send(&[mouse(flags as u32, 0)])
    }

    fn scroll(&mut self, dx: i32, dy: i32) -> Result<(), String> {
        // Browser deltas are pixels (≈100 per notch); Windows wants notches of 120, up positive.
        let mut inputs = Vec::new();
        if dy != 0 {
            inputs.push(mouse(MOUSEEVENTF_WHEEL as u32, -dy * WHEEL_DELTA / 100));
        }
        if dx != 0 {
            inputs.push(mouse(MOUSEEVENTF_HWHEEL as u32, dx * WHEEL_DELTA / 100));
        }
        if inputs.is_empty() { Ok(()) } else { send(&inputs) }
    }

    fn key(&mut self, code: &str, down: bool) -> Result<(), String> {
        let (vk, extended) = windows_vk(code).ok_or_else(|| format!("no key {code}"))?;
        let mut flags = 0u32;
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY as u32;
        }
        if !down {
            flags |= KEYEVENTF_KEYUP as u32;
        }
        send(&[keyboard(vk, 0, flags)])
    }

    fn text(&mut self, text: &str) -> Result<(), String> {
        let mut inputs = Vec::new();
        for unit in text.encode_utf16() {
            inputs.push(keyboard(0, unit, KEYEVENTF_UNICODE as u32));
            inputs.push(keyboard(0, unit, (KEYEVENTF_UNICODE | KEYEVENTF_KEYUP) as u32));
        }
        if inputs.is_empty() { Ok(()) } else { send(&inputs) }
    }
}
