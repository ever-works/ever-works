//! Virtual displays (FL-07 P3, T-45, FR-59, FR-60): on a Linux X11 session the
//! owner may add a display that has no monitor behind it — what a headless
//! machine needs before there is anything to watch — with a name and a size
//! from a fixed list. It lasts until it is removed or the X server stops (a
//! reboot), whether or not a helper is still running.
//!
//! The node asks for it only after the owner confirmed (`confirm`, audit
//! `node.desktop.display.add|remove`); the helper still refuses every size not
//! in [`SIZES`], every name it would not show, and removing any display it did
//! not add. Everywhere else — macOS, Windows, Wayland, an X server without a
//! free output — it refuses by name.
//!
//! Refusal codes (answered in `displayChange`): `unsupported` (not Linux),
//! `unsupported-session` (not an X11 session), `randr-unavailable` (no RandR
//! 1.2), `no-free-output`, `screen-too-large`, `size-not-offered`,
//! `invalid-name`, `unknown-display`, `not-virtual`, `failed`.

#[cfg(target_os = "linux")]
#[path = "virtual_display_x11.rs"]
pub(crate) mod x11;

/// The sizes a virtual display may have (FR-59: "a size from a fixed list").
pub const SIZES: [(u32, u32); 5] = [
    (1280, 720),
    (1366, 768),
    (1600, 900),
    (1920, 1080),
    (2560, 1440),
];

/// The longest name a virtual display may carry, in characters.
pub const MAX_NAME_CHARS: usize = 40;

/// The output property that marks a display this helper added (and holds its name).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const PROPERTY: &str = "EVER_WORKS_VIRTUAL_DISPLAY";

pub fn size_offered(width: u32, height: u32) -> bool {
    SIZES.contains(&(width, height))
}

/// A name the picker can show: 1–40 characters once trimmed, no control characters.
pub fn valid_name(name: &str) -> bool {
    let trimmed = name.trim();
    let count = trimmed.chars().count();
    (1..=MAX_NAME_CHARS).contains(&count) && !trimmed.chars().any(char::is_control)
}

/// 60 Hz timings with reduced blanking (VESA CVT-RB): the custom mode the X server is given.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
pub struct Timings {
    pub dot_clock: u32,
    pub hsync_start: u16,
    pub hsync_end: u16,
    pub htotal: u16,
    pub vsync_start: u16,
    pub vsync_end: u16,
    pub vtotal: u16,
}

#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
pub fn timings(width: u16, height: u16) -> Timings {
    // CVT-RB: 160 pixels of horizontal blanking (48 front porch, 32 sync); a vertical
    // blanking of at least 460 µs, of which 3 lines front porch and 5 sync (16:9).
    let htotal = width.saturating_add(160);
    let vtotal_f = f64::from(height) / (1.0 - 460e-6 * 60.0);
    let vtotal = (vtotal_f.ceil() as u16).max(height.saturating_add(14));
    let dot_clock = u32::from(htotal) * u32::from(vtotal) * 60;
    Timings {
        dot_clock,
        hsync_start: width.saturating_add(48),
        hsync_end: width.saturating_add(80),
        htotal,
        vsync_start: height.saturating_add(3),
        vsync_end: height.saturating_add(8),
        vtotal,
    }
}

/// Check a request before anything touches the X server.
pub fn check_request(name: &str, width: u32, height: u32) -> Result<(), &'static str> {
    if !valid_name(name) {
        return Err("invalid-name");
    }
    if !size_offered(width, height) {
        return Err("size-not-offered");
    }
    Ok(())
}

/// Add a virtual display; answers its display id.
pub fn add(name: &str, width: u32, height: u32) -> Result<String, &'static str> {
    check_request(name, width, height)?;
    add_checked(name.trim(), width, height)
}

#[cfg(target_os = "linux")]
fn add_checked(name: &str, width: u32, height: u32) -> Result<String, &'static str> {
    x11::add(name, width, height)
}

#[cfg(not(target_os = "linux"))]
fn add_checked(_name: &str, _width: u32, _height: u32) -> Result<String, &'static str> {
    Err("unsupported")
}

/// Remove a virtual display this helper (or an earlier one) added; never a real display.
#[cfg(target_os = "linux")]
pub fn remove(display_id: &str) -> Result<(), &'static str> {
    x11::remove(display_id)
}

#[cfg(not(target_os = "linux"))]
pub fn remove(_display_id: &str) -> Result<(), &'static str> {
    Err("unsupported")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offers_a_fixed_list_of_sizes_only() {
        assert!(size_offered(1920, 1080));
        assert!(!size_offered(1920, 1081));
        assert!(!size_offered(8192, 8192));
        assert_eq!(check_request("Desk", 640, 480), Err("size-not-offered"));
    }

    #[test]
    fn names_are_short_printable_text() {
        assert!(valid_name("Second screen"));
        assert!(valid_name("  Écran 2  "));
        assert!(!valid_name("   "));
        assert!(!valid_name("a\nb"));
        assert!(!valid_name(&"x".repeat(41)));
        assert_eq!(check_request("\u{7}", 1920, 1080), Err("invalid-name"));
        assert_eq!(check_request("Desk", 1920, 1080), Ok(()));
    }

    #[test]
    fn computes_reduced_blanking_timings_at_sixty_hertz() {
        let t = timings(1920, 1080);
        assert_eq!((t.hsync_start, t.hsync_end, t.htotal), (1968, 2000, 2080));
        assert_eq!((t.vsync_start, t.vsync_end), (1083, 1088));
        assert!(t.vtotal >= 1080 + 14);
        let refresh = f64::from(t.dot_clock) / (f64::from(t.htotal) * f64::from(t.vtotal));
        assert!((refresh - 60.0).abs() < 0.01);
        for (w, h) in SIZES {
            let t = timings(w as u16, h as u16);
            assert!(
                t.hsync_start > w as u16 && t.hsync_end > t.hsync_start && t.htotal > t.hsync_end
            );
            assert!(
                t.vsync_start > h as u16 && t.vsync_end > t.vsync_start && t.vtotal > t.vsync_end
            );
        }
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn is_refused_by_name_off_linux() {
        assert_eq!(add("Desk", 1920, 1080), Err("unsupported"));
        assert_eq!(remove("VIRTUAL1"), Err("unsupported"));
        // A bad request is refused for what it is first.
        assert_eq!(add("Desk", 1, 1), Err("size-not-offered"));
    }
}
