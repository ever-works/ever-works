//! The on-screen marker while the machine is controlled (FL-07, owner question 10).
//!
//! While the node says a stream is in controlling mode (`controlMarker`), the
//! helper draws a coloured border around the controlled display, so the
//! person at the machine can see that someone else is driving it:
//!
//! | OS      | How                                                                                  |
//! | ------- | ------------------------------------------------------------------------------------ |
//! | Windows | four topmost, click-through, never-activated strips, excluded from screen capture    |
//! | X11     | four override-redirect strips with an empty input shape (clicks pass through)        |
//! | macOS   | not yet (it needs an AppKit window and run loop): `hello` does not offer the feature |
//!
//! The border sits inside the display's edge and never takes a click, the
//! focus or a keystroke. It goes away when the node says so, when the stream
//! stops and when the helper exits.

use crate::capture::DisplayRect;

#[cfg(windows)]
mod win;
#[cfg(target_os = "linux")]
mod x11;

/// Border thickness, in the display's injection pixels (physical on Windows, root pixels on X11).
pub const THICKNESS: f64 = 6.0;

/// The border colour, `0xRRGGBB` (an orange red that reads on light and dark desktops).
pub const COLOR: u32 = 0x00E8_4820;

/// One way of drawing the border.
pub trait Marker {
    /// Show the border around `rect` (or move it there).
    fn show(&mut self, rect: DisplayRect);
    fn hide(&mut self);
    /// Put a shown border back above windows that were raised over it since.
    fn raise(&mut self);
}

/// Whether this build can draw the marker (what `hello` offers as `controlMarker`).
pub fn supported() -> bool {
    cfg!(any(windows, target_os = "linux"))
}

#[cfg(windows)]
pub fn open() -> Option<Box<dyn Marker>> {
    win::open()
}

#[cfg(target_os = "linux")]
pub fn open() -> Option<Box<dyn Marker>> {
    x11::open()
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn open() -> Option<Box<dyn Marker>> {
    None
}

/// One strip of the border: x, y, width, height in whole pixels.
pub type Strip = (i32, i32, i32, i32);

/// The four strips of a border `thickness` wide just inside `rect`: top, bottom, left, right.
/// The side strips stop where the top and bottom ones start, so no pixel is covered twice.
pub fn strips(rect: DisplayRect, thickness: f64) -> [Strip; 4] {
    let x = rect.x.round() as i32;
    let y = rect.y.round() as i32;
    let w = rect.width.round().max(1.0) as i32;
    let h = rect.height.round().max(1.0) as i32;
    let t = (thickness.round() as i32)
        .clamp(1, (w / 2).max(1))
        .min((h / 2).max(1));
    [
        (x, y, w, t),
        (x, y + h - t, w, t),
        (x, y + t, t, (h - 2 * t).max(1)),
        (x + w - t, y + t, t, (h - 2 * t).max(1)),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_the_display_from_inside() {
        let second = DisplayRect {
            x: 1920.0,
            y: 0.0,
            width: 2560.0,
            height: 1440.0,
        };
        assert_eq!(
            strips(second, THICKNESS),
            [
                (1920, 0, 2560, 6),
                (1920, 1434, 2560, 6),
                (1920, 6, 6, 1428),
                (4474, 6, 6, 1428),
            ]
        );
    }

    #[test]
    fn never_exceeds_a_tiny_display_or_goes_negative() {
        let tiny = DisplayRect {
            x: -10.0,
            y: -10.0,
            width: 8.0,
            height: 4.0,
        };
        for (_, _, w, h) in strips(tiny, THICKNESS) {
            assert!(w >= 1 && h >= 1);
            assert!(w <= 8 && h <= 4);
        }
    }

    #[test]
    fn is_offered_where_it_can_be_drawn() {
        assert_eq!(supported(), cfg!(any(windows, target_os = "linux")));
    }
}
