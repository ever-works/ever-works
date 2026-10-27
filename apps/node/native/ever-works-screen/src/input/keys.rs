//! `KeyboardEvent.code` → each OS's key identity (FL-07 P2). Physical keys, so a
//! keyboard layout cannot turn one key into another (the contracts' blocked
//! shortcuts are physical too). A code missing here is refused, never guessed.

/// X11 keysym of a physical key (US layout names, the X server maps them to keycodes).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn x11_keysym(code: &str) -> Option<u32> {
    if let Some(letter) = code.strip_prefix("Key") {
        let c = letter.chars().next()?;
        if letter.len() == 1 && c.is_ascii_uppercase() {
            return Some(c.to_ascii_lowercase() as u32);
        }
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        let c = digit.chars().next()?;
        if digit.len() == 1 && c.is_ascii_digit() {
            return Some(c as u32);
        }
    }
    if let Some(n) = code.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()) {
        if (1..=12).contains(&n) {
            return Some(0xffbe + n - 1);
        }
    }
    Some(match code {
        "Enter" | "NumpadEnter" => 0xff0d,
        "Escape" => 0xff1b,
        "Backspace" => 0xff08,
        "Tab" => 0xff09,
        "Space" => 0x20,
        "Minus" => 0x2d,
        "Equal" => 0x3d,
        "BracketLeft" => 0x5b,
        "BracketRight" => 0x5d,
        "Backslash" => 0x5c,
        "Semicolon" => 0x3b,
        "Quote" => 0x27,
        "Backquote" => 0x60,
        "Comma" => 0x2c,
        "Period" => 0x2e,
        "Slash" => 0x2f,
        "CapsLock" => 0xffe5,
        "ArrowLeft" => 0xff51,
        "ArrowUp" => 0xff52,
        "ArrowRight" => 0xff53,
        "ArrowDown" => 0xff54,
        "Home" => 0xff50,
        "End" => 0xff57,
        "PageUp" => 0xff55,
        "PageDown" => 0xff56,
        "Insert" => 0xff63,
        "Delete" => 0xffff,
        "ShiftLeft" => 0xffe1,
        "ShiftRight" => 0xffe2,
        "ControlLeft" => 0xffe3,
        "ControlRight" => 0xffe4,
        "AltLeft" => 0xffe9,
        "AltRight" => 0xffea,
        _ => return None,
    })
}

/// Windows virtual-key code and whether it is an "extended" key.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_vk(code: &str) -> Option<(u16, bool)> {
    if let Some(letter) = code.strip_prefix("Key") {
        let c = letter.chars().next()?;
        if letter.len() == 1 && c.is_ascii_uppercase() {
            return Some((c as u16, false));
        }
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        let c = digit.chars().next()?;
        if digit.len() == 1 && c.is_ascii_digit() {
            return Some((c as u16, false));
        }
    }
    if let Some(n) = code.strip_prefix('F').and_then(|n| n.parse::<u16>().ok()) {
        if (1..=12).contains(&n) {
            return Some((0x70 + n - 1, false));
        }
    }
    Some(match code {
        "Enter" => (0x0d, false),
        "NumpadEnter" => (0x0d, true),
        "Escape" => (0x1b, false),
        "Backspace" => (0x08, false),
        "Tab" => (0x09, false),
        "Space" => (0x20, false),
        "Minus" => (0xbd, false),
        "Equal" => (0xbb, false),
        "BracketLeft" => (0xdb, false),
        "BracketRight" => (0xdd, false),
        "Backslash" => (0xdc, false),
        "Semicolon" => (0xba, false),
        "Quote" => (0xde, false),
        "Backquote" => (0xc0, false),
        "Comma" => (0xbc, false),
        "Period" => (0xbe, false),
        "Slash" => (0xbf, false),
        "CapsLock" => (0x14, false),
        "ArrowLeft" => (0x25, true),
        "ArrowUp" => (0x26, true),
        "ArrowRight" => (0x27, true),
        "ArrowDown" => (0x28, true),
        "Home" => (0x24, true),
        "End" => (0x23, true),
        "PageUp" => (0x21, true),
        "PageDown" => (0x22, true),
        "Insert" => (0x2d, true),
        "Delete" => (0x2e, true),
        "ShiftLeft" => (0xa0, false),
        "ShiftRight" => (0xa1, false),
        "ControlLeft" => (0xa2, false),
        "ControlRight" => (0xa3, true),
        "AltLeft" => (0xa4, false),
        "AltRight" => (0xa5, true),
        _ => return None,
    })
}

/// macOS virtual key code (`kVK_*`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_keycode(code: &str) -> Option<u16> {
    Some(match code {
        "KeyA" => 0x00,
        "KeyS" => 0x01,
        "KeyD" => 0x02,
        "KeyF" => 0x03,
        "KeyH" => 0x04,
        "KeyG" => 0x05,
        "KeyZ" => 0x06,
        "KeyX" => 0x07,
        "KeyC" => 0x08,
        "KeyV" => 0x09,
        "KeyB" => 0x0b,
        "KeyQ" => 0x0c,
        "KeyW" => 0x0d,
        "KeyE" => 0x0e,
        "KeyR" => 0x0f,
        "KeyY" => 0x10,
        "KeyT" => 0x11,
        "Digit1" => 0x12,
        "Digit2" => 0x13,
        "Digit3" => 0x14,
        "Digit4" => 0x15,
        "Digit6" => 0x16,
        "Digit5" => 0x17,
        "Equal" => 0x18,
        "Digit9" => 0x19,
        "Digit7" => 0x1a,
        "Minus" => 0x1b,
        "Digit8" => 0x1c,
        "Digit0" => 0x1d,
        "BracketRight" => 0x1e,
        "KeyO" => 0x1f,
        "KeyU" => 0x20,
        "BracketLeft" => 0x21,
        "KeyI" => 0x22,
        "KeyP" => 0x23,
        "Enter" | "NumpadEnter" => 0x24,
        "KeyL" => 0x25,
        "KeyJ" => 0x26,
        "Quote" => 0x27,
        "KeyK" => 0x28,
        "Semicolon" => 0x29,
        "Backslash" => 0x2a,
        "Comma" => 0x2b,
        "Slash" => 0x2c,
        "KeyN" => 0x2d,
        "KeyM" => 0x2e,
        "Period" => 0x2f,
        "Tab" => 0x30,
        "Space" => 0x31,
        "Backquote" => 0x32,
        "Backspace" => 0x33,
        "Escape" => 0x35,
        "ShiftLeft" => 0x38,
        "CapsLock" => 0x39,
        "AltLeft" => 0x3a,
        "ControlLeft" => 0x3b,
        "ShiftRight" => 0x3c,
        "AltRight" => 0x3d,
        "ControlRight" => 0x3e,
        "F1" => 0x7a,
        "F2" => 0x78,
        "F3" => 0x63,
        "F4" => 0x76,
        "F5" => 0x60,
        "F6" => 0x61,
        "F7" => 0x62,
        "F8" => 0x64,
        "F9" => 0x65,
        "F10" => 0x6d,
        "F11" => 0x67,
        "F12" => 0x6f,
        "Insert" => 0x72,
        "Home" => 0x73,
        "PageUp" => 0x74,
        "Delete" => 0x75,
        "End" => 0x77,
        "PageDown" => 0x79,
        "ArrowLeft" => 0x7b,
        "ArrowRight" => 0x7c,
        "ArrowDown" => 0x7d,
        "ArrowUp" => 0x7e,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_common_keys_on_every_os() {
        for code in ["KeyA", "KeyZ", "Digit0", "F1", "F12", "Enter", "ArrowLeft", "ShiftLeft", "Space"] {
            assert!(x11_keysym(code).is_some(), "x11 {code}");
            assert!(windows_vk(code).is_some(), "win {code}");
            assert!(mac_keycode(code).is_some(), "mac {code}");
        }
        assert_eq!(x11_keysym("KeyA"), Some(0x61));
        assert_eq!(windows_vk("KeyA"), Some((0x41, false)));
        assert_eq!(windows_vk("ArrowUp"), Some((0x26, true)));
        assert_eq!(x11_keysym("F12"), Some(0xffc9));
    }

    #[test]
    fn refuses_what_it_does_not_know() {
        for code in ["MetaLeft", "Key", "KeyAB", "F13", "LaunchMail", ""] {
            assert_eq!(x11_keysym(code), None, "x11 {code}");
            assert_eq!(windows_vk(code), None, "win {code}");
            assert_eq!(mac_keycode(code), None, "mac {code}");
        }
    }
}
