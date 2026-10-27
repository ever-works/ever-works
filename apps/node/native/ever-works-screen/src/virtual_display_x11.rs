//! Virtual displays on X11 (T-45) through RandR 1.2 requests — no `xrandr`
//! process, no file. Adding one takes a FREE output (disconnected, no CRTC)
//! with a CRTC nobody uses, gives it a 60 Hz mode of the asked size, grows the
//! screen and turns the CRTC on to the right of everything else. The output is
//! then tagged with [`PROPERTY`](super::PROPERTY) (holding the display's name),
//! which lives in the X server: every later helper lists it as virtual, and
//! only a tagged output can be removed.
//!
//! What the X server offers decides: drivers that expose spare outputs (the
//! `dummy` driver of a headless machine, the `VIRTUAL` outputs of some GPU
//! drivers, or an unplugged connector) take one; Xvfb and a server with every
//! output in use answer `no-free-output`. A desktop environment that manages
//! the display layout itself may rearrange the new display; it is not asked.

use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::randr::{self, ConnectionExt as _, ModeFlag, ModeInfo, Rotation, SetConfig};
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _, PropMode, Window};
use x11rb::rust_connection::RustConnection;
use x11rb::{CURRENT_TIME, NONE};

use super::{PROPERTY, timings};
use crate::capture::{linux_session_reasons, sanitize_id};

/// The prefix of the modes this helper creates (so removal deletes only its own).
const MODE_PREFIX: &str = "EW_";

fn connect() -> Result<(RustConnection, Window), &'static str> {
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
        return Err("unsupported-session");
    }
    let (conn, screen_num) = RustConnection::connect(None).map_err(|_| "unsupported-session")?;
    let root = conn
        .setup()
        .roots
        .get(screen_num)
        .map(|screen| screen.root)
        .ok_or("unsupported-session")?;
    if conn
        .extension_information(randr::X11_EXTENSION_NAME)
        .ok()
        .flatten()
        .is_none()
    {
        return Err("randr-unavailable");
    }
    let version = conn
        .randr_query_version(1, 5)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .ok_or("randr-unavailable")?;
    if (version.major_version, version.minor_version) < (1, 2) {
        return Err("randr-unavailable");
    }
    Ok((conn, root))
}

fn failed<E>(_: E) -> &'static str {
    "failed"
}

/// Millimetres for `pixels` at 96 dots per inch (what the screen size request wants).
fn millimetres(pixels: u32) -> u32 {
    (f64::from(pixels) * 25.4 / 96.0).round() as u32
}

/// The bottom-right corner of every CRTC that shows something.
fn used_extent(
    conn: &RustConnection,
    crtcs: &[randr::Crtc],
    config_timestamp: u32,
) -> Result<(u32, u32), &'static str> {
    let mut extent = (0u32, 0u32);
    for crtc in crtcs {
        let info = conn
            .randr_get_crtc_info(*crtc, config_timestamp)
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        if info.mode == NONE {
            continue;
        }
        let right = (i32::from(info.x) + i32::from(info.width)).max(0) as u32;
        let bottom = (i32::from(info.y) + i32::from(info.height)).max(0) as u32;
        extent = (extent.0.max(right), extent.1.max(bottom));
    }
    Ok(extent)
}

pub fn add(name: &str, width: u32, height: u32) -> Result<String, &'static str> {
    let (conn, root) = connect()?;
    let resources = conn
        .randr_get_screen_resources_current(root)
        .map_err(failed)?
        .reply()
        .map_err(failed)?;
    let config_timestamp = resources.config_timestamp;

    // A free output: not connected, showing nothing, with a CRTC nobody uses.
    let mut chosen = None;
    'outputs: for output in &resources.outputs {
        let info = conn
            .randr_get_output_info(*output, config_timestamp)
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        // A connected output is never taken: it may be a monitor someone turned off. (The dummy
        // driver keeps a removed virtual display's output connected, so each add takes the next
        // free output; it has sixteen.)
        if info.connection == randr::Connection::CONNECTED || info.crtc != NONE {
            continue;
        }
        for crtc in &info.crtcs {
            let crtc_info = conn
                .randr_get_crtc_info(*crtc, config_timestamp)
                .map_err(failed)?
                .reply()
                .map_err(failed)?;
            if crtc_info.mode == NONE && crtc_info.outputs.is_empty() {
                chosen = Some((*output, *crtc, info.name.clone()));
                break 'outputs;
            }
        }
    }
    let (output, crtc, output_name) = chosen.ok_or("no-free-output")?;

    // The screen grows to the right to make room; refuse before changing anything.
    let range = conn
        .randr_get_screen_size_range(root)
        .map_err(failed)?
        .reply()
        .map_err(failed)?;
    let (used_w, used_h) = used_extent(&conn, &resources.crtcs, config_timestamp)?;
    let new_w = used_w + width;
    let new_h = used_h.max(height);
    if new_w > u32::from(range.max_width) || new_h > u32::from(range.max_height) {
        return Err("screen-too-large");
    }

    // The mode: an earlier one of this size is reused.
    let mode_name = format!("{MODE_PREFIX}{width}x{height}");
    let mut offset = 0usize;
    let mut mode = None;
    for info in &resources.modes {
        let end = offset + usize::from(info.name_len);
        if resources.names.get(offset..end) == Some(mode_name.as_bytes()) {
            mode = Some(info.id);
        }
        offset = end;
    }
    let mode = match mode {
        Some(mode) => mode,
        None => {
            let t = timings(width as u16, height as u16);
            let info = ModeInfo {
                id: 0,
                width: width as u16,
                height: height as u16,
                dot_clock: t.dot_clock,
                hsync_start: t.hsync_start,
                hsync_end: t.hsync_end,
                htotal: t.htotal,
                hskew: 0,
                vsync_start: t.vsync_start,
                vsync_end: t.vsync_end,
                vtotal: t.vtotal,
                name_len: mode_name.len() as u16,
                mode_flags: ModeFlag::HSYNC_POSITIVE | ModeFlag::VSYNC_NEGATIVE,
            };
            conn.randr_create_mode(root, info, mode_name.as_bytes())
                .map_err(failed)?
                .reply()
                .map_err(failed)?
                .mode
        }
    };
    conn.randr_add_output_mode(output, mode)
        .map_err(failed)?
        .check()
        .map_err(failed)?;

    let undo_mode = |conn: &RustConnection| {
        let _ = conn.randr_delete_output_mode(output, mode);
        let _ = conn.flush();
    };
    let current = conn
        .get_geometry(root)
        .map_err(failed)?
        .reply()
        .map_err(failed)?;
    let screen_w = new_w.max(u32::from(current.width));
    let screen_h = new_h.max(u32::from(current.height));
    if conn
        .randr_set_screen_size(
            root,
            screen_w as u16,
            screen_h as u16,
            millimetres(screen_w),
            millimetres(screen_h),
        )
        .map_err(failed)
        .and_then(|cookie| cookie.check().map_err(failed))
        .is_err()
    {
        undo_mode(&conn);
        return Err("failed");
    }
    let set = conn
        .randr_set_crtc_config(
            crtc,
            CURRENT_TIME,
            config_timestamp,
            used_w as i16,
            0,
            mode,
            Rotation::ROTATE0,
            &[output],
        )
        .map_err(failed)
        .and_then(|cookie| cookie.reply().map_err(failed));
    if !matches!(set, Ok(ref reply) if reply.status == SetConfig::SUCCESS) {
        undo_mode(&conn);
        return Err("failed");
    }

    // The tag: what makes it virtual (and removable) for every later helper.
    let property = conn
        .intern_atom(false, PROPERTY.as_bytes())
        .map_err(failed)?
        .reply()
        .map_err(failed)?
        .atom;
    let utf8 = conn
        .intern_atom(false, b"UTF8_STRING")
        .map_err(failed)?
        .reply()
        .map_err(failed)?
        .atom;
    conn.randr_change_output_property(
        output,
        property,
        utf8,
        8,
        PropMode::REPLACE,
        name.len() as u32,
        name.as_bytes(),
    )
    .map_err(failed)?
    .check()
    .map_err(failed)?;
    conn.flush().map_err(failed)?;
    Ok(sanitize_id(&String::from_utf8_lossy(&output_name)))
}

/// The virtual-display name an output carries, when this helper (or an earlier one) added it.
pub fn tag_of(conn: &RustConnection, output: randr::Output, property: u32) -> Option<String> {
    if property == NONE {
        return None;
    }
    let reply = conn
        .randr_get_output_property(output, property, AtomEnum::ANY, 0, 64, false, false)
        .ok()?
        .reply()
        .ok()?;
    if reply.type_ == NONE {
        return None;
    }
    Some(String::from_utf8_lossy(&reply.data).into_owned())
}

/// The tag's atom if any client ever created it (none: no output can be virtual).
pub fn tag_atom(conn: &RustConnection) -> u32 {
    conn.intern_atom(true, PROPERTY.as_bytes())
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .map(|reply| reply.atom)
        .unwrap_or(NONE)
}

pub fn remove(display_id: &str) -> Result<(), &'static str> {
    let (conn, root) = connect()?;
    let resources = conn
        .randr_get_screen_resources_current(root)
        .map_err(failed)?
        .reply()
        .map_err(failed)?;
    let config_timestamp = resources.config_timestamp;
    let property = tag_atom(&conn);
    for output in &resources.outputs {
        let info = conn
            .randr_get_output_info(*output, config_timestamp)
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        if sanitize_id(&String::from_utf8_lossy(&info.name)) != display_id {
            continue;
        }
        // Never a display this helper did not add.
        if tag_of(&conn, *output, property).is_none() {
            return Err("not-virtual");
        }
        if info.crtc != NONE {
            let off = conn
                .randr_set_crtc_config(
                    info.crtc,
                    CURRENT_TIME,
                    config_timestamp,
                    0,
                    0,
                    NONE,
                    Rotation::ROTATE0,
                    &[],
                )
                .map_err(failed)?
                .reply()
                .map_err(failed)?;
            if off.status != SetConfig::SUCCESS {
                return Err("failed");
            }
        }
        conn.randr_delete_output_property(*output, property)
            .map_err(failed)?
            .check()
            .map_err(failed)?;
        // Its modes go too (only the ones this helper made).
        let mut offset = 0usize;
        for mode in &resources.modes {
            let end = offset + usize::from(mode.name_len);
            let own = resources
                .names
                .get(offset..end)
                .is_some_and(|name| name.starts_with(MODE_PREFIX.as_bytes()));
            offset = end;
            if own && info.modes.contains(&mode.id) {
                let _ = conn
                    .randr_delete_output_mode(*output, mode.id)
                    .map(|cookie| cookie.check());
                // Still in use by another virtual display: the server refuses, which is fine.
                let _ = conn
                    .randr_destroy_mode(mode.id)
                    .map(|cookie| cookie.check());
            }
        }
        // Shrink the screen back to what is still shown.
        let (used_w, used_h) = used_extent(&conn, &resources.crtcs, config_timestamp)?;
        let range = conn
            .randr_get_screen_size_range(root)
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        let w = used_w.max(u32::from(range.min_width));
        let h = used_h.max(u32::from(range.min_height));
        if w > 0 && h > 0 {
            let _ = conn
                .randr_set_screen_size(root, w as u16, h as u16, millimetres(w), millimetres(h))
                .map(|cookie| cookie.check());
        }
        conn.flush().map_err(failed)?;
        return Ok(());
    }
    Err("unknown-display")
}
