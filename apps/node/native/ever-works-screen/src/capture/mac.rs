//! macOS capture (FL-07 FR-22): CoreGraphics displays and `CGDisplayCreateImage`,
//! after a Screen Recording preflight that names the missing permission instead
//! of failing silently (spec U4). Accessibility is preflighted too and reported
//! as `permission-accessibility` — it blocks control (P2), never watching.
//!
//! ScreenCaptureKit (`SCStream`) is the plan's capture path and the follow-up
//! behind the same trait: `CGDisplayCreateImage` is deprecated on recent macOS
//! releases and does not draw the pointer. See `PACKAGING.md`.

use std::collections::HashMap;
use std::ffi::c_void;

use super::{Capturer, Display, DisplayRect, Opened, PixelLayout, RawImage, dedupe_ids, order_displays};

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGGetActiveDisplayList(max_displays: u32, active_displays: *mut u32, display_count: *mut u32) -> i32;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> CGRect;
    fn CGDisplayIsBuiltin(display: u32) -> u32;
    fn CGDisplayCopyDisplayMode(display: u32) -> *mut c_void;
    fn CGDisplayModeGetPixelWidth(mode: *mut c_void) -> usize;
    fn CGDisplayModeGetPixelHeight(mode: *mut c_void) -> usize;
    fn CGDisplayModeRelease(mode: *mut c_void);
    fn CGDisplayCreateImage(display: u32) -> *mut c_void;
    fn CGImageGetWidth(image: *mut c_void) -> usize;
    fn CGImageGetHeight(image: *mut c_void) -> usize;
    fn CGImageGetBytesPerRow(image: *mut c_void) -> usize;
    fn CGImageGetBitsPerPixel(image: *mut c_void) -> usize;
    fn CGImageGetBitmapInfo(image: *mut c_void) -> u32;
    fn CGImageGetDataProvider(image: *mut c_void) -> *mut c_void;
    fn CGDataProviderCopyData(provider: *mut c_void) -> *const c_void;
    fn CGImageRelease(image: *mut c_void);
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGPreflightPostEventAccess() -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFDataGetLength(data: *const c_void) -> isize;
    fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
    fn CFRelease(object: *const c_void);
}

const BYTE_ORDER_MASK: u32 = 0x7000;
const BYTE_ORDER_32_LITTLE: u32 = 0x2000;
const ALPHA_INFO_MASK: u32 = 0x1f;
const ALPHA_PREMULTIPLIED_LAST: u32 = 1;
const ALPHA_LAST: u32 = 3;
const ALPHA_NONE_SKIP_LAST: u32 = 5;

struct CoreGraphicsCapturer {
    ids: HashMap<String, u32>,
}

pub fn open() -> Opened {
    let mut reasons = Vec::new();
    let screen = unsafe { CGPreflightScreenCaptureAccess() };
    if !screen {
        reasons.push("permission-screen-recording");
    }
    if !unsafe { CGPreflightPostEventAccess() } {
        reasons.push("permission-accessibility");
    }
    Opened {
        capturer: if screen {
            Some(Box::new(CoreGraphicsCapturer { ids: HashMap::new() }))
        } else {
            None
        },
        reasons,
    }
}

fn active_displays() -> Vec<u32> {
    let mut ids = [0u32; 16];
    let mut count: u32 = 0;
    let error = unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) };
    if error != 0 {
        return Vec::new();
    }
    ids[..(count as usize).min(ids.len())].to_vec()
}

impl Capturer for CoreGraphicsCapturer {
    fn displays(&mut self) -> Result<Vec<Display>, String> {
        let main = unsafe { CGMainDisplayID() };
        let mut displays = Vec::new();
        let mut native = Vec::new();
        for (index, id) in active_displays().into_iter().enumerate() {
            let bounds = unsafe { CGDisplayBounds(id) };
            let mode = unsafe { CGDisplayCopyDisplayMode(id) };
            let (pixel_w, pixel_h) = if mode.is_null() {
                (bounds.size.width as usize, bounds.size.height as usize)
            } else {
                let size = unsafe { (CGDisplayModeGetPixelWidth(mode), CGDisplayModeGetPixelHeight(mode)) };
                unsafe { CGDisplayModeRelease(mode) };
                size
            };
            if pixel_w == 0 || pixel_h == 0 {
                continue;
            }
            let scale = if bounds.size.width > 0.0 {
                (pixel_w as f64 / bounds.size.width * 100.0).round() / 100.0
            } else {
                1.0
            };
            let builtin = unsafe { CGDisplayIsBuiltin(id) } != 0;
            displays.push(Display {
                id: format!("cg-{id}"),
                name: if builtin {
                    "Built-in display".into()
                } else {
                    format!("Display {}", index + 1)
                },
                width: pixel_w as u32,
                height: pixel_h as u32,
                scale,
                primary: id == main,
                is_virtual: false,
            });
            native.push(id);
        }
        if displays.is_empty() {
            return Err("no active display".into());
        }
        dedupe_ids(&mut displays);
        self.ids = displays
            .iter()
            .zip(native)
            .map(|(display, id)| (display.id.clone(), id))
            .collect();
        Ok(order_displays(displays))
    }

    fn display_rect(&mut self, display_id: &str) -> Option<DisplayRect> {
        if !self.ids.contains_key(display_id) {
            let _ = self.displays();
        }
        let id = *self.ids.get(display_id)?;
        // Global points: what Quartz events are posted in.
        let bounds = unsafe { CGDisplayBounds(id) };
        Some(DisplayRect {
            x: bounds.origin.x,
            y: bounds.origin.y,
            width: bounds.size.width,
            height: bounds.size.height,
        })
    }

    fn capture(&mut self, display_id: &str) -> Result<RawImage, String> {
        if !self.ids.contains_key(display_id) {
            self.displays()?;
        }
        let id = *self
            .ids
            .get(display_id)
            .ok_or_else(|| "unknown display".to_string())?;
        let image = unsafe { CGDisplayCreateImage(id) };
        if image.is_null() {
            return Err("the display could not be captured (Screen Recording permission?)".into());
        }
        let (width, height, stride, bits, info, provider) = unsafe {
            (
                CGImageGetWidth(image),
                CGImageGetHeight(image),
                CGImageGetBytesPerRow(image),
                CGImageGetBitsPerPixel(image),
                CGImageGetBitmapInfo(image),
                CGImageGetDataProvider(image),
            )
        };
        let data = if provider.is_null() {
            std::ptr::null()
        } else {
            unsafe { CGDataProviderCopyData(provider) }
        };
        let result = read_picture(data, width, height, stride, bits, info);
        unsafe {
            if !data.is_null() {
                CFRelease(data);
            }
            CGImageRelease(image);
        }
        result
    }
}

/// Copy a CoreGraphics picture out of its `CFData` (borrowed, released by the caller).
fn read_picture(
    data: *const c_void,
    width: usize,
    height: usize,
    stride: usize,
    bits: usize,
    info: u32,
) -> Result<RawImage, String> {
    if data.is_null() {
        return Err("no picture data".to_string());
    }
    if bits != 32 || width == 0 || height == 0 || stride < width * 4 {
        return Err(format!("unsupported picture format ({bits} bits per pixel)"));
    }
    let little = info & BYTE_ORDER_MASK == BYTE_ORDER_32_LITTLE;
    let alpha = info & ALPHA_INFO_MASK;
    let alpha_last = matches!(alpha, ALPHA_PREMULTIPLIED_LAST | ALPHA_LAST | ALPHA_NONE_SKIP_LAST);
    let layout = match (little, alpha_last) {
        (true, false) => PixelLayout::Bgra,
        (false, false) => PixelLayout::Argb,
        (false, true) => PixelLayout::Rgba,
        (true, true) => return Err("unsupported pixel order (ABGR)".to_string()),
    };
    let length = unsafe { CFDataGetLength(data) }.max(0) as usize;
    if length < stride * (height - 1) + width * 4 {
        return Err("short picture".to_string());
    }
    // SAFETY: `data` is a live CFData of `length` bytes until the caller releases it.
    let bytes = unsafe { std::slice::from_raw_parts(CFDataGetBytePtr(data), length) }.to_vec();
    Ok(RawImage {
        width: width as u32,
        height: height as u32,
        stride,
        layout,
        data: bytes,
    })
}
