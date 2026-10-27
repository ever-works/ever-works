//! Windows input (FL-07 P2): `SetCursorPos` in physical pixels (the process is
//! per-monitor DPI aware), `SendInput` for buttons, the wheel, keys (virtual-key
//! codes, extended flag where the key needs it) and text (`KEYEVENTF_UNICODE`,
//! one UTF-16 unit at a time). Input never reaches the secure desktop: Windows
//! refuses it there, which is the point.

use std::mem::size_of;

use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_HWHEEL,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT, SendInput,
    VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SetCursorPos;

use super::keys::windows_vk;
use super::{Button, Held, Injector, RELEASABLE_MODIFIERS};

/// One wheel notch.
const WHEEL_DELTA: i32 = 120;

struct SendInputInjector;

pub fn open() -> Result<Box<dyn Injector>, &'static str> {
    Ok(Box::new(SendInputInjector))
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            size_of::<INPUT>() as i32,
        )
    };
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
        if ok == 0 {
            Err("the pointer could not be moved".into())
        } else {
            Ok(())
        }
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
        send(&[mouse(flags, 0)])
    }

    fn scroll(&mut self, dx: i32, dy: i32) -> Result<(), String> {
        // Browser deltas are pixels (≈100 per notch); Windows wants notches of 120, up positive.
        let mut inputs = Vec::new();
        if dy != 0 {
            inputs.push(mouse(MOUSEEVENTF_WHEEL, -dy * WHEEL_DELTA / 100));
        }
        if dx != 0 {
            inputs.push(mouse(MOUSEEVENTF_HWHEEL, dx * WHEEL_DELTA / 100));
        }
        if inputs.is_empty() {
            Ok(())
        } else {
            send(&inputs)
        }
    }

    fn key(&mut self, code: &str, down: bool) -> Result<(), String> {
        let (vk, extended) = windows_vk(code).ok_or_else(|| format!("no key {code}"))?;
        let mut flags = 0u32;
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        if !down {
            flags |= KEYEVENTF_KEYUP;
        }
        send(&[keyboard(vk, 0, flags)])
    }

    fn text(&mut self, text: &str) -> Result<(), String> {
        let mut inputs = Vec::new();
        for unit in text.encode_utf16() {
            inputs.push(keyboard(0, unit, KEYEVENTF_UNICODE));
            inputs.push(keyboard(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
        if inputs.is_empty() {
            Ok(())
        } else {
            send(&inputs)
        }
    }

    fn held(&mut self) -> Result<Held, String> {
        // The async state includes injected input. Buttons are read and released as the same
        // (physical) buttons `SendInput` presses, so a swapped mouse needs no mapping here.
        let down = |vk: u16| (unsafe { GetAsyncKeyState(i32::from(vk)) } as u16) & 0x8000 != 0;
        let keys = RELEASABLE_MODIFIERS
            .into_iter()
            .filter(|code| windows_vk(code).is_some_and(|(vk, _)| down(vk)))
            .collect();
        let buttons = [
            (VK_LBUTTON, Button::Left),
            (VK_MBUTTON, Button::Middle),
            (VK_RBUTTON, Button::Right),
        ]
        .into_iter()
        .filter(|(vk, _)| down(*vk))
        .map(|(_, button)| button)
        .collect();
        Ok(Held { keys, buttons })
    }
}
