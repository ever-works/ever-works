//! Linux / X11 capture (FL-07 FR-24): RandR monitors, `GetImage` of one
//! monitor's rectangle of the root window, the pointer composited from XFixes.
//!
//! The X connection comes from `DISPLAY` / `XAUTHORITY`, which the node hands
//! the helper (and nothing else). A Wayland session is refused by name before a
//! connection is even tried.

use std::collections::HashMap;

use x11rb::connection::Connection;
use x11rb::protocol::randr::ConnectionExt as _;
use x11rb::protocol::xfixes::ConnectionExt as _;
use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat, ImageOrder, Window};
use x11rb::rust_connection::RustConnection;

use super::{
    Capturer, Display, DisplayRect, Opened, PixelLayout, RawImage, blend_cursor, dedupe_ids,
    linux_session_reasons, order_displays, sanitize_id,
};

#[derive(Clone, Copy, Debug)]
struct Rect {
    x: i16,
    y: i16,
    w: u16,
    h: u16,
}

struct X11Capturer {
    conn: RustConnection,
    root: Window,
    screen_size: (u16, u16),
    cursor: bool,
    rects: HashMap<String, Rect>,
}

pub fn open() -> Opened {
    let session_type = std::env::var("XDG_SESSION_TYPE").ok();
    let display = std::env::var("DISPLAY").ok();
    let wayland = std::env::var("WAYLAND_DISPLAY").ok();
    let reasons = linux_session_reasons(
        session_type.as_deref(),
        display.as_deref(),
        wayland.as_deref(),
    );
    if !reasons.is_empty() {
        return Opened {
            capturer: None,
            reasons,
        };
    }
    let Ok((conn, screen_num)) = RustConnection::connect(None) else {
        return Opened {
            capturer: None,
            reasons: vec!["no-display-session"],
        };
    };
    let (root, screen_size) = match conn.setup().roots.get(screen_num) {
        Some(screen) => (
            screen.root,
            (screen.width_in_pixels, screen.height_in_pixels),
        ),
        None => {
            return Opened {
                capturer: None,
                reasons: vec!["no-display-session"],
            };
        }
    };
    // RandR 1.5 (monitors) and XFixes 5 (cursor image) must be announced before use.
    let _ = conn
        .randr_query_version(1, 5)
        .ok()
        .and_then(|cookie| cookie.reply().ok());
    let cursor = conn
        .xfixes_query_version(5, 0)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .is_some();
    Opened {
        capturer: Some(Box::new(X11Capturer {
            conn,
            root,
            screen_size,
            cursor,
            rects: HashMap::new(),
        })),
        reasons: Vec::new(),
    }
}

impl X11Capturer {
    fn monitors(&self) -> Vec<(Display, Rect)> {
        let reply = self
            .conn
            .randr_get_monitors(self.root, true)
            .ok()
            .and_then(|cookie| cookie.reply().ok());
        let mut out = Vec::new();
        // A display this helper added carries its name in an output property (T-45).
        let tag = crate::virtual_display::x11::tag_atom(&self.conn);
        if let Some(reply) = reply {
            for (index, monitor) in reply.monitors.iter().enumerate() {
                if monitor.width == 0 || monitor.height == 0 {
                    continue;
                }
                let virtual_name = monitor.outputs.first().and_then(|output| {
                    crate::virtual_display::x11::tag_of(&self.conn, *output, tag)
                });
                let monitor_name = self
                    .conn
                    .get_atom_name(monitor.name)
                    .ok()
                    .and_then(|cookie| cookie.reply().ok())
                    .map(|atom| String::from_utf8_lossy(&atom.name).into_owned())
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| format!("Monitor {}", index + 1));
                out.push((
                    Display {
                        id: sanitize_id(&monitor_name),
                        is_virtual: virtual_name.is_some(),
                        name: virtual_name.unwrap_or(monitor_name),
                        width: monitor.width as u32,
                        height: monitor.height as u32,
                        scale: 1.0,
                        primary: monitor.primary,
                    },
                    Rect {
                        x: monitor.x,
                        y: monitor.y,
                        w: monitor.width,
                        h: monitor.height,
                    },
                ));
            }
        }
        if out.is_empty() {
            // No RandR 1.5: the whole screen is one display.
            let (w, h) = self.screen_size;
            out.push((
                Display {
                    id: "screen0".into(),
                    name: "Screen".into(),
                    width: w as u32,
                    height: h as u32,
                    scale: 1.0,
                    primary: true,
                    is_virtual: false,
                },
                Rect { x: 0, y: 0, w, h },
            ));
        }
        out
    }
}

impl Capturer for X11Capturer {
    fn displays(&mut self) -> Result<Vec<Display>, String> {
        let pairs = self.monitors();
        let (mut displays, rects): (Vec<Display>, Vec<Rect>) = pairs.into_iter().unzip();
        dedupe_ids(&mut displays);
        self.rects = displays
            .iter()
            .zip(rects)
            .map(|(display, rect)| (display.id.clone(), rect))
            .collect();
        Ok(order_displays(displays))
    }

    fn display_rect(&mut self, display_id: &str) -> Option<DisplayRect> {
        if !self.rects.contains_key(display_id) {
            let _ = self.displays();
        }
        self.rects.get(display_id).map(|rect| DisplayRect {
            x: rect.x as f64,
            y: rect.y as f64,
            width: rect.w as f64,
            height: rect.h as f64,
        })
    }

    fn capture(&mut self, display_id: &str) -> Result<RawImage, String> {
        if !self.rects.contains_key(display_id) {
            self.displays()?;
        }
        let rect = *self
            .rects
            .get(display_id)
            .ok_or_else(|| "unknown display".to_string())?;
        let reply = self
            .conn
            .get_image(
                ImageFormat::Z_PIXMAP,
                self.root,
                rect.x,
                rect.y,
                rect.w,
                rect.h,
                !0,
            )
            .map_err(|error| error.to_string())?
            .reply()
            .map_err(|error| error.to_string())?;
        let setup = self.conn.setup();
        let bits = setup
            .pixmap_formats
            .iter()
            .find(|format| format.depth == reply.depth)
            .map(|format| format.bits_per_pixel)
            .unwrap_or(0);
        if bits != 32 || setup.image_byte_order != ImageOrder::LSB_FIRST {
            return Err(format!(
                "unsupported X pixel format (depth {}, {bits} bits per pixel)",
                reply.depth
            ));
        }
        let stride = rect.w as usize * 4;
        if reply.data.len() < stride * rect.h as usize {
            return Err("the X server returned a short image".into());
        }
        let mut image = RawImage {
            width: rect.w as u32,
            height: rect.h as u32,
            stride,
            layout: PixelLayout::Bgra,
            data: reply.data,
        };
        // The cursor image is asked for only when XFixes 5 was announced.
        if self.cursor
            && let Some(cursor) = self
                .conn
                .xfixes_get_cursor_image()
                .ok()
                .and_then(|cookie| cookie.reply().ok())
        {
            blend_cursor(
                &mut image,
                &cursor.cursor_image,
                cursor.width as u32,
                cursor.height as u32,
                cursor.x as i64 - cursor.xhot as i64 - rect.x as i64,
                cursor.y as i64 - cursor.yhot as i64 - rect.y as i64,
            );
        }
        Ok(image)
    }
}
