//! Windows capture (FL-07 FR-23): `EnumDisplayMonitors` for the displays, a
//! GDI `BitBlt` of one monitor's rectangle (with `CAPTUREBLT`, so layered
//! windows are included) and the pointer drawn with `DrawIconEx`.
//!
//! The helper must run in the signed-in user's interactive session: in session
//! 0 (a service) or with no input desktop (locked, switched away) it reports
//! `no-display-session` and captures nothing (spec U6). DXGI desktop
//! duplication is the faster follow-up behind the same trait.

use std::collections::HashMap;
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{LPARAM, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleBitmap,
    CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, EnumDisplayMonitors, GetDC,
    GetDIBits, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW, MONITORINFOF_PRIMARY,
    ReleaseDC, SRCCOPY, SelectObject,
};
use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows_sys::Win32::System::StationsAndDesktops::{
    CloseDesktop, DESKTOP_READOBJECTS, OpenInputDesktop,
};
use windows_sys::Win32::System::Threading::GetCurrentProcessId;
use windows_sys::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForMonitor, MDT_EFFECTIVE_DPI,
    SetProcessDpiAwarenessContext,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CURSOR_SHOWING, CURSORINFO, DI_NORMAL, DrawIconEx, GetCursorInfo, GetIconInfo, ICONINFO,
};

use super::{
    Capturer, Display, DisplayRect, Opened, PixelLayout, RawImage, dedupe_ids, order_displays, sanitize_id,
};

struct GdiCapturer {
    rects: HashMap<String, RECT>,
}

pub fn open() -> Opened {
    // Physical pixels, per monitor: without this a scaled display is captured at its logical size.
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let reasons = session_reasons();
    if !reasons.is_empty() {
        return Opened {
            capturer: None,
            reasons,
        };
    }
    Opened {
        capturer: Some(Box::new(GdiCapturer {
            rects: HashMap::new(),
        })),
        reasons: Vec::new(),
    }
}

/// `no-display-session` in session 0 (a service) or with no input desktop to read.
fn session_reasons() -> Vec<&'static str> {
    let mut session: u32 = 0;
    let found = unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) };
    if found == 0 || session == 0 {
        return vec!["no-display-session"];
    }
    let desktop = unsafe { OpenInputDesktop(0, 0, DESKTOP_READOBJECTS) };
    if desktop.is_null() {
        return vec!["no-display-session"];
    }
    unsafe {
        CloseDesktop(desktop);
    }
    Vec::new()
}

unsafe extern "system" fn collect_monitor(
    monitor: HMONITOR,
    _hdc: HDC,
    _clip: *mut RECT,
    data: LPARAM,
) -> i32 {
    // SAFETY: `data` is the `&mut Vec<HMONITOR>` `monitors()` passed, alive for the whole enumeration.
    let list = unsafe { &mut *(data as *mut Vec<HMONITOR>) };
    list.push(monitor);
    1
}

fn monitors() -> Vec<(Display, RECT)> {
    let mut handles: Vec<HMONITOR> = Vec::new();
    unsafe {
        EnumDisplayMonitors(
            null_mut(),
            null(),
            Some(collect_monitor),
            &mut handles as *mut Vec<HMONITOR> as LPARAM,
        );
    }
    let mut out = Vec::new();
    for (index, handle) in handles.into_iter().enumerate() {
        let mut info: MONITORINFOEXW = unsafe { zeroed() };
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        let ok = unsafe { GetMonitorInfoW(handle, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO) };
        if ok == 0 {
            continue;
        }
        let rect = info.monitorInfo.rcMonitor;
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            continue;
        }
        let device_len = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
        let device = String::from_utf16_lossy(&info.szDevice[..device_len]);
        let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
        let scale = if unsafe { GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) } == 0 {
            (dpi_x as f64 / 96.0 * 100.0).round() / 100.0
        } else {
            1.0
        };
        out.push((
            Display {
                id: sanitize_id(&device),
                name: format!("Display {}", index + 1),
                width: width as u32,
                height: height as u32,
                scale,
                primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
                is_virtual: false,
            },
            rect,
        ));
    }
    out
}

/// Draw the pointer onto the memory DC, in the monitor's coordinates.
fn draw_cursor(memory: HDC, rect: &RECT) {
    unsafe {
        let mut cursor: CURSORINFO = zeroed();
        cursor.cbSize = size_of::<CURSORINFO>() as u32;
        if GetCursorInfo(&mut cursor) == 0 || cursor.flags & CURSOR_SHOWING == 0 || cursor.hCursor.is_null() {
            return;
        }
        let mut icon: ICONINFO = zeroed();
        if GetIconInfo(cursor.hCursor, &mut icon) == 0 {
            return;
        }
        DrawIconEx(
            memory,
            cursor.ptScreenPos.x - rect.left - icon.xHotspot as i32,
            cursor.ptScreenPos.y - rect.top - icon.yHotspot as i32,
            cursor.hCursor,
            0,
            0,
            0,
            null_mut(),
            DI_NORMAL,
        );
        if !icon.hbmMask.is_null() {
            DeleteObject(icon.hbmMask);
        }
        if !icon.hbmColor.is_null() {
            DeleteObject(icon.hbmColor);
        }
    }
}

fn grab(rect: &RECT) -> Result<RawImage, String> {
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width <= 0 || height <= 0 {
        return Err("empty monitor".into());
    }
    let mut data = vec![0u8; width as usize * height as usize * 4];
    let (copied, lines) = unsafe {
        let screen = GetDC(null_mut());
        if screen.is_null() {
            return Err("no screen device context (is anyone signed in?)".into());
        }
        let memory = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        if memory.is_null() || bitmap.is_null() {
            if !bitmap.is_null() {
                DeleteObject(bitmap);
            }
            if !memory.is_null() {
                DeleteDC(memory);
            }
            ReleaseDC(null_mut(), screen);
            return Err("could not allocate a capture bitmap".into());
        }
        let previous = SelectObject(memory, bitmap);
        let copied = BitBlt(
            memory,
            0,
            0,
            width,
            height,
            screen,
            rect.left,
            rect.top,
            SRCCOPY | CAPTUREBLT,
        );
        if copied != 0 {
            draw_cursor(memory, rect);
        }
        let mut info: BITMAPINFO = zeroed();
        info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        // Negative height: rows top-down, as every other backend delivers them.
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        SelectObject(memory, previous);
        let lines = GetDIBits(
            memory,
            bitmap,
            0,
            height as u32,
            data.as_mut_ptr() as *mut c_void,
            &mut info,
            DIB_RGB_COLORS,
        );
        DeleteObject(bitmap);
        DeleteDC(memory);
        ReleaseDC(null_mut(), screen);
        (copied, lines)
    };
    if copied == 0 || lines <= 0 {
        return Err("the screen could not be copied (locked, or switched to another desktop)".into());
    }
    Ok(RawImage {
        width: width as u32,
        height: height as u32,
        stride: width as usize * 4,
        layout: PixelLayout::Bgra,
        data,
    })
}

impl Capturer for GdiCapturer {
    fn displays(&mut self) -> Result<Vec<Display>, String> {
        let pairs = monitors();
        if pairs.is_empty() {
            return Err("no monitor is attached to this session".into());
        }
        let (mut displays, rects): (Vec<Display>, Vec<RECT>) = pairs.into_iter().unzip();
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
            x: rect.left as f64,
            y: rect.top as f64,
            width: (rect.right - rect.left) as f64,
            height: (rect.bottom - rect.top) as f64,
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
        grab(&rect)
    }
}
