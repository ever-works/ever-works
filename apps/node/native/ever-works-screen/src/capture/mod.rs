//! Display enumeration and capture, one backend per operating system.
//!
//! | OS      | Capture (P1)                                   | Displays                 | Reasons it reports                                   |
//! | ------- | ---------------------------------------------- | ------------------------ | ---------------------------------------------------- |
//! | Linux   | X11 `GetImage` on the root window + XFixes cursor | RandR monitors        | `wayland-unsupported`, `no-display-session`          |
//! | Windows | GDI `BitBlt` of the monitor rectangle + cursor | `EnumDisplayMonitors`    | `no-display-session` (session 0, no input desktop)   |
//! | macOS   | CoreGraphics `CGDisplayCreateImage`            | `CGGetActiveDisplayList` | `permission-screen-recording`, `permission-accessibility` |
//!
//! The plan's faster paths (XShm on X11, DXGI desktop duplication on Windows,
//! ScreenCaptureKit on macOS) are follow-ups behind the same trait; P1 ships
//! the paths that need no extra session plumbing (see `PACKAGING.md`).

use serde::Serialize;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod win;
#[cfg(target_os = "linux")]
mod x11;

/// How the four bytes of one captured pixel are ordered (alpha, when present, is ignored).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PixelLayout {
    Bgra,
    Rgba,
    Argb,
}

/// One captured picture at the display's native resolution.
#[derive(Clone, Debug)]
pub struct RawImage {
    pub width: u32,
    pub height: u32,
    /// Bytes from the start of one row to the next (≥ `width * 4`).
    pub stride: usize,
    pub layout: PixelLayout,
    pub data: Vec<u8>,
}

/// One display, as the node and the platform see it (contracts `FleetDisplayView`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub primary: bool,
    #[serde(rename = "virtual")]
    pub is_virtual: bool,
}

/// Where a display sits in the coordinate space the OS injects pointer events in
/// (X11 root pixels, Windows physical pixels, macOS global points) — P2 control.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DisplayRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A capture backend for the running session.
pub trait Capturer {
    /// Every display, the primary first.
    fn displays(&mut self) -> Result<Vec<Display>, String>;
    /// One full picture of one display, cursor included where the OS allows it.
    fn capture(&mut self, display_id: &str) -> Result<RawImage, String>;
    /// The display's place in the input coordinate space (after a `displays` call).
    fn display_rect(&mut self, display_id: &str) -> Option<DisplayRect>;
}

/// What opening the session's capture gave: a backend, or the reasons there is none.
pub struct Opened {
    pub capturer: Option<Box<dyn Capturer>>,
    /// Contracts `FleetDesktopReason` values (kebab-case); empty when capture works.
    pub reasons: Vec<&'static str>,
}

#[cfg(target_os = "linux")]
pub fn open() -> Opened {
    x11::open()
}

#[cfg(windows)]
pub fn open() -> Opened {
    win::open()
}

#[cfg(target_os = "macos")]
pub fn open() -> Opened {
    mac::open()
}

#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
pub fn open() -> Opened {
    Opened {
        capturer: None,
        reasons: vec!["kind-unsupported"],
    }
}

/// The operating system name `hello` reports.
pub fn platform() -> &'static str {
    if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "other"
    }
}

/// Why a Linux session cannot be captured, from what the node handed the
/// helper's environment (pure, so it is tested on every OS).
///
/// A Wayland session is refused by name even when an X server (XWayland) is
/// reachable: XWayland would show only the X clients, never the real desktop,
/// and a partial picture of someone's screen is worse than an honest "no".
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn linux_session_reasons(
    session_type: Option<&str>,
    display: Option<&str>,
    wayland_display: Option<&str>,
) -> Vec<&'static str> {
    let session = session_type.unwrap_or("").trim().to_ascii_lowercase();
    let has_display = display.map(|value| !value.trim().is_empty()).unwrap_or(false);
    let has_wayland = wayland_display
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if session == "wayland" || (has_wayland && !has_display) {
        return vec!["wayland-unsupported"];
    }
    if !has_display {
        return vec!["no-display-session"];
    }
    Vec::new()
}

/// A display id the contracts accept (`[A-Za-z0-9._:-]{1,64}`), from whatever the OS calls it.
pub fn sanitize_id(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "display".into()
    } else {
        cleaned
    }
}

/// Make every id in the list unique (`DP-1`, `DP-1-2`, …), keeping the order.
pub fn dedupe_ids(displays: &mut [Display]) {
    let mut seen = std::collections::HashSet::new();
    for display in displays.iter_mut() {
        let base = display.id.clone();
        let mut candidate = base.clone();
        let mut n = 2;
        while !seen.insert(candidate.clone()) {
            let suffix = format!("-{n}");
            let keep = 64usize.saturating_sub(suffix.len());
            candidate = format!("{}{}", &base[..base.len().min(keep)], suffix);
            n += 1;
        }
        display.id = candidate;
    }
}

/// Put the primary display first (exactly one primary; the first when none claims it).
pub fn order_displays(mut displays: Vec<Display>) -> Vec<Display> {
    if displays.is_empty() {
        return displays;
    }
    let primary = displays.iter().position(|d| d.primary).unwrap_or(0);
    let first = displays.remove(primary);
    displays.insert(0, first);
    for (index, display) in displays.iter_mut().enumerate() {
        display.primary = index == 0;
    }
    displays
}

/// Blend a premultiplied ARGB cursor image onto a 4-byte-per-pixel picture at (`left`, `top`).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn blend_cursor(
    image: &mut RawImage,
    cursor: &[u32],
    cursor_w: u32,
    cursor_h: u32,
    left: i64,
    top: i64,
) {
    let (r_off, g_off, b_off) = match image.layout {
        PixelLayout::Bgra => (2, 1, 0),
        PixelLayout::Rgba => (0, 1, 2),
        PixelLayout::Argb => (1, 2, 3),
    };
    for cy in 0..cursor_h as i64 {
        let y = top + cy;
        if y < 0 || y >= image.height as i64 {
            continue;
        }
        for cx in 0..cursor_w as i64 {
            let x = left + cx;
            if x < 0 || x >= image.width as i64 {
                continue;
            }
            let Some(&argb) = cursor.get((cy * cursor_w as i64 + cx) as usize) else {
                continue;
            };
            let alpha = (argb >> 24) & 0xff;
            if alpha == 0 {
                continue;
            }
            let p = y as usize * image.stride + x as usize * 4;
            if p + 3 >= image.data.len() {
                continue;
            }
            let inverse = 255 - alpha;
            let channels = [
                (r_off, (argb >> 16) & 0xff),
                (g_off, (argb >> 8) & 0xff),
                (b_off, argb & 0xff),
            ];
            for (offset, source) in channels {
                let destination = image.data[p + offset] as u32;
                image.data[p + offset] = (source + (destination * inverse + 127) / 255).min(255) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(id: &str, primary: bool) -> Display {
        Display {
            id: id.into(),
            name: id.into(),
            width: 10,
            height: 10,
            scale: 1.0,
            primary,
            is_virtual: false,
        }
    }

    #[test]
    fn refuses_wayland_by_name() {
        assert_eq!(
            linux_session_reasons(Some("wayland"), Some(":0"), Some("wayland-0")),
            vec!["wayland-unsupported"]
        );
        assert_eq!(
            linux_session_reasons(None, None, Some("wayland-0")),
            vec!["wayland-unsupported"]
        );
        assert_eq!(
            linux_session_reasons(Some("x11"), None, None),
            vec!["no-display-session"]
        );
        assert!(linux_session_reasons(Some("x11"), Some(":0"), None).is_empty());
        assert!(linux_session_reasons(None, Some(":1"), None).is_empty());
    }

    #[test]
    fn sanitizes_and_dedupes_ids() {
        assert_eq!(sanitize_id(r"\\.\DISPLAY1"), "DISPLAY1");
        assert_eq!(sanitize_id("???"), "display");
        let mut list = vec![display("DP-1", false), display("DP-1", false), display("DP-1", true)];
        dedupe_ids(&mut list);
        let ids: Vec<&str> = list.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["DP-1", "DP-1-2", "DP-1-3"]);
    }

    #[test]
    fn orders_the_primary_first() {
        let ordered = order_displays(vec![display("a", false), display("b", true), display("c", true)]);
        let ids: Vec<&str> = ordered.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a", "c"]);
        assert_eq!(ordered.iter().filter(|d| d.primary).count(), 1);
    }

    #[test]
    fn serializes_virtual_under_its_contract_name() {
        let json = serde_json::to_string(&display("a", true)).unwrap();
        assert!(json.contains(r#""virtual":false"#));
        assert!(json.contains(r#""primary":true"#));
    }

    #[test]
    fn blends_a_cursor_inside_the_picture_only() {
        let mut image = RawImage {
            width: 2,
            height: 1,
            stride: 8,
            layout: PixelLayout::Bgra,
            data: vec![0; 8],
        };
        // Opaque white at (1, 0); a second pixel outside the picture.
        blend_cursor(&mut image, &[0xffff_ffff, 0xffff_ffff], 2, 1, 1, 0);
        assert_eq!(image.data, vec![0, 0, 0, 0, 255, 255, 255, 0]);
    }
}
