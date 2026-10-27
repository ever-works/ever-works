//! X11 marker: four override-redirect windows (no window manager frames them)
//! filled with the marker colour, each with an EMPTY input shape so every
//! click passes through to what is below. Without the Shape extension (1.1+)
//! the strips would swallow clicks at the screen's edges, so there is no
//! marker at all and `hello` does not offer it.

use x11rb::connection::Connection;
use x11rb::protocol::shape::{ConnectionExt as _, SK, SO};
use x11rb::protocol::xproto::{
    ClipOrdering, ConfigureWindowAux, ConnectionExt as _, CreateWindowAux, StackMode, Window,
    WindowClass,
};
use x11rb::rust_connection::RustConnection;
use x11rb::{COPY_DEPTH_FROM_PARENT, COPY_FROM_PARENT};

use super::{COLOR, Marker, Strip, THICKNESS, strips};
use crate::capture::{DisplayRect, linux_session_reasons};

struct X11Marker {
    conn: RustConnection,
    root: Window,
    pixel: u32,
    windows: Vec<Window>,
    shown: bool,
}

pub fn open() -> Option<Box<dyn Marker>> {
    let session_type = std::env::var("XDG_SESSION_TYPE").ok();
    let display = std::env::var("DISPLAY").ok();
    let wayland = std::env::var("WAYLAND_DISPLAY").ok();
    if !linux_session_reasons(
        session_type.as_deref(),
        display.as_deref(),
        wayland.as_deref(),
    )
    .is_empty()
    {
        return None;
    }
    let (conn, screen_num) = RustConnection::connect(None).ok()?;
    let (root, pixel) = {
        let screen = conn.setup().roots.get(screen_num)?;
        // A true-colour root takes the RGB value as its pixel; anything else gets its white.
        let pixel = if screen.root_depth >= 24 {
            COLOR
        } else {
            screen.white_pixel
        };
        (screen.root, pixel)
    };
    let shape = conn
        .shape_query_version()
        .ok()
        .and_then(|cookie| cookie.reply().ok())?;
    if (shape.major_version, shape.minor_version) < (1, 1) {
        return None;
    }
    Some(Box::new(X11Marker {
        conn,
        root,
        pixel,
        windows: Vec::new(),
        shown: false,
    }))
}

impl X11Marker {
    fn create(&mut self, strips: &[Strip; 4]) -> Result<(), String> {
        let error = |error: &dyn std::fmt::Display| error.to_string();
        for &(x, y, w, h) in strips {
            let id = self.conn.generate_id().map_err(|e| error(&e))?;
            self.conn
                .create_window(
                    COPY_DEPTH_FROM_PARENT,
                    id,
                    self.root,
                    x as i16,
                    y as i16,
                    w as u16,
                    h as u16,
                    0,
                    WindowClass::INPUT_OUTPUT,
                    COPY_FROM_PARENT,
                    &CreateWindowAux::new()
                        .override_redirect(1)
                        .background_pixel(self.pixel),
                )
                .map_err(|e| error(&e))?;
            // No input region: the strip is seen, never clicked.
            self.conn
                .shape_rectangles(SO::SET, SK::INPUT, ClipOrdering::UNSORTED, id, 0, 0, &[])
                .map_err(|e| error(&e))?;
            self.windows.push(id);
        }
        Ok(())
    }
}

impl Marker for X11Marker {
    fn show(&mut self, rect: DisplayRect) {
        let strips = strips(rect, THICKNESS);
        if self.windows.is_empty() && self.create(&strips).is_err() {
            return;
        }
        for (window, (x, y, w, h)) in self.windows.iter().zip(strips) {
            let _ = self.conn.configure_window(
                *window,
                &ConfigureWindowAux::new()
                    .x(x)
                    .y(y)
                    .width(w.max(1) as u32)
                    .height(h.max(1) as u32)
                    .stack_mode(StackMode::ABOVE),
            );
            let _ = self.conn.map_window(*window);
        }
        let _ = self.conn.flush();
        self.shown = true;
    }

    fn hide(&mut self) {
        for window in &self.windows {
            let _ = self.conn.unmap_window(*window);
        }
        let _ = self.conn.flush();
        self.shown = false;
    }

    fn raise(&mut self) {
        if !self.shown {
            return;
        }
        for window in &self.windows {
            let _ = self.conn.configure_window(
                *window,
                &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE),
            );
        }
        let _ = self.conn.flush();
    }
}

impl Drop for X11Marker {
    fn drop(&mut self) {
        for window in &self.windows {
            let _ = self.conn.destroy_window(*window);
        }
        let _ = self.conn.flush();
    }
}
