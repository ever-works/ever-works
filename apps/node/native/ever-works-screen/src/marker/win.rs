//! Windows marker: four topmost, layered, click-through (`WS_EX_TRANSPARENT`),
//! never-activated tool windows on their own thread with its own message loop.
//! `WDA_EXCLUDEFROMCAPTURE` keeps them out of the helper's own picture (and any
//! other screen capture) on Windows 10 2004 and later; on older systems the
//! border simply shows in the picture too.

use std::mem::zeroed;
use std::ptr::{null, null_mut};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Gdi::CreateSolidBrush;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, HWND_TOPMOST,
    LWA_ALPHA, MSG, PM_NOREMOVE, PeekMessageW, PostThreadMessageW, RegisterClassW, SW_HIDE,
    SWP_NOACTIVATE, SWP_SHOWWINDOW, SetLayeredWindowAttributes, SetWindowDisplayAffinity,
    SetWindowPos, ShowWindow, TranslateMessage, WDA_EXCLUDEFROMCAPTURE, WM_APP, WM_QUIT, WNDCLASSW,
    WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

use super::{COLOR, Marker, Strip, THICKNESS, strips};
use crate::capture::DisplayRect;

/// Posted to the marker thread: apply the wanted state now.
const WM_SYNC: u32 = WM_APP + 1;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Wanted {
    Hidden,
    Shown([Strip; 4]),
}

struct WinMarker {
    thread_id: u32,
    wanted: Arc<Mutex<Wanted>>,
    thread: Option<JoinHandle<()>>,
}

pub fn open() -> Option<Box<dyn Marker>> {
    let wanted = Arc::new(Mutex::new(Wanted::Hidden));
    let shared = Arc::clone(&wanted);
    let (ready, started) = mpsc::channel();
    let thread = thread::Builder::new()
        .name("control-marker".into())
        .spawn(move || marker_thread(&shared, &ready))
        .ok()?;
    match started.recv_timeout(Duration::from_secs(5)) {
        Ok(Some(thread_id)) => Some(Box::new(WinMarker {
            thread_id,
            wanted,
            thread: Some(thread),
        })),
        _ => None,
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// `0xRRGGBB` → a `COLORREF` (`0x00BBGGRR`).
fn colorref(rgb: u32) -> u32 {
    ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)
}

fn marker_thread(wanted: &Mutex<Wanted>, ready: &mpsc::Sender<Option<u32>>) {
    // SAFETY: plain Win32 calls on this thread's own windows and message queue; every
    // pointer passed lives for the call (the class name and window title for the thread).
    unsafe {
        let mut message: MSG = zeroed();
        // Creates this thread's message queue before anyone posts to it.
        PeekMessageW(&mut message, null_mut(), 0, 0, PM_NOREMOVE);
        let instance = GetModuleHandleW(null());
        let class_name = wide("EverWorksControlMarker");
        let title = wide("Ever Works: this computer is being controlled");
        let class = WNDCLASSW {
            lpfnWndProc: Some(DefWindowProcW),
            hInstance: instance,
            hbrBackground: CreateSolidBrush(colorref(COLOR)),
            lpszClassName: class_name.as_ptr(),
            ..zeroed()
        };
        if RegisterClassW(&class) == 0 {
            let _ = ready.send(None);
            return;
        }
        let mut windows: Vec<HWND> = Vec::with_capacity(4);
        for _ in 0..4 {
            let window = CreateWindowExW(
                WS_EX_TOPMOST
                    | WS_EX_TOOLWINDOW
                    | WS_EX_NOACTIVATE
                    | WS_EX_LAYERED
                    | WS_EX_TRANSPARENT,
                class_name.as_ptr(),
                title.as_ptr(),
                WS_POPUP,
                0,
                0,
                1,
                1,
                null_mut(),
                null_mut(),
                instance,
                null(),
            );
            if window.is_null() {
                for created in &windows {
                    DestroyWindow(*created);
                }
                let _ = ready.send(None);
                return;
            }
            // Layered + transparent: drawn opaque, yet every click goes to the window below.
            SetLayeredWindowAttributes(window, 0, 255, LWA_ALPHA);
            // Best effort: keeps the border out of the picture the controller sees.
            SetWindowDisplayAffinity(window, WDA_EXCLUDEFROMCAPTURE);
            windows.push(window);
        }
        let _ = ready.send(Some(GetCurrentThreadId()));
        while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
            if message.hwnd.is_null() && message.message == WM_SYNC {
                let state = wanted.lock().map(|guard| *guard).unwrap_or(Wanted::Hidden);
                apply(&windows, state);
                continue;
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        for window in windows {
            DestroyWindow(window);
        }
    }
}

/// SAFETY: `windows` are this thread's live windows.
unsafe fn apply(windows: &[HWND], state: Wanted) {
    match state {
        Wanted::Shown(strips) => {
            for (window, (x, y, w, h)) in windows.iter().zip(strips) {
                unsafe {
                    SetWindowPos(
                        *window,
                        HWND_TOPMOST,
                        x,
                        y,
                        w,
                        h,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    );
                }
            }
        }
        Wanted::Hidden => {
            for window in windows {
                unsafe {
                    ShowWindow(*window, SW_HIDE);
                }
            }
        }
    }
}

impl WinMarker {
    fn set(&self, state: Option<Wanted>) {
        if let Some(state) = state
            && let Ok(mut guard) = self.wanted.lock()
        {
            *guard = state;
        }
        // SAFETY: posting to the marker thread's queue; a failure only means it already ended.
        unsafe {
            PostThreadMessageW(self.thread_id, WM_SYNC, 0, 0);
        }
    }
}

impl Marker for WinMarker {
    fn show(&mut self, rect: DisplayRect) {
        self.set(Some(Wanted::Shown(strips(rect, THICKNESS))));
    }

    fn hide(&mut self) {
        self.set(Some(Wanted::Hidden));
    }

    fn raise(&mut self) {
        self.set(None);
    }
}

impl Drop for WinMarker {
    fn drop(&mut self) {
        // SAFETY: as in `set`; WM_QUIT ends the thread's loop, which destroys its windows.
        unsafe {
            PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
