//! Downscale a captured picture to the stream's width (box average), into
//! tightly packed RGB — the form the tile differ and the JPEG encoder read.
//!
//! Diffing happens at OUTPUT resolution so tiles stay stable and the CPU cost
//! is bounded by the preset, not by a 4K display (plan §3). The helper never
//! upscales: a display narrower than the preset is sent at its own size.

use crate::capture::{PixelLayout, RawImage};
use crate::tiles::RgbFrame;

/// The output size for a `src_w × src_h` picture at most `max_w` wide.
pub fn target_size(src_w: u32, src_h: u32, max_w: u32) -> (u32, u32) {
    if src_w == 0 || src_h == 0 {
        return (0, 0);
    }
    if src_w <= max_w {
        return (src_w, src_h);
    }
    let width = max_w.max(1);
    let height = ((src_h as u64 * width as u64 + src_w as u64 / 2) / src_w as u64).max(1) as u32;
    (width, height)
}

/// Byte offsets of red, green and blue inside one 4-byte pixel.
fn channel_offsets(layout: PixelLayout) -> (usize, usize, usize) {
    match layout {
        PixelLayout::Bgra => (2, 1, 0),
        PixelLayout::Rgba => (0, 1, 2),
        PixelLayout::Argb => (1, 2, 3),
    }
}

/// Box-average `image` down to at most `max_w` pixels wide, as RGB.
pub fn to_rgb_scaled(image: &RawImage, max_w: u32) -> Result<RgbFrame, String> {
    let (src_w, src_h) = (image.width, image.height);
    if src_w == 0 || src_h == 0 {
        return Err("empty picture".into());
    }
    if image.stride < src_w as usize * 4 {
        return Err("stride shorter than a row".into());
    }
    let needed = image.stride * (src_h as usize - 1) + src_w as usize * 4;
    if image.data.len() < needed {
        return Err("picture shorter than its size".into());
    }
    let (dst_w, dst_h) = target_size(src_w, src_h, max_w);
    let (r_off, g_off, b_off) = channel_offsets(image.layout);
    let mut out = vec![0u8; dst_w as usize * dst_h as usize * 3];
    for dy in 0..dst_h {
        let sy0 = (dy as u64 * src_h as u64 / dst_h as u64) as u32;
        let sy1 = (((dy as u64 + 1) * src_h as u64 / dst_h as u64) as u32).max(sy0 + 1);
        for dx in 0..dst_w {
            let sx0 = (dx as u64 * src_w as u64 / dst_w as u64) as u32;
            let sx1 = (((dx as u64 + 1) * src_w as u64 / dst_w as u64) as u32).max(sx0 + 1);
            let (mut r, mut g, mut b, mut n) = (0u64, 0u64, 0u64, 0u64);
            for sy in sy0..sy1.min(src_h) {
                let row = sy as usize * image.stride;
                for sx in sx0..sx1.min(src_w) {
                    let p = row + sx as usize * 4;
                    r += image.data[p + r_off] as u64;
                    g += image.data[p + g_off] as u64;
                    b += image.data[p + b_off] as u64;
                    n += 1;
                }
            }
            let o = (dy as usize * dst_w as usize + dx as usize) * 3;
            if n > 0 {
                out[o] = ((r + n / 2) / n) as u8;
                out[o + 1] = ((g + n / 2) / n) as u8;
                out[o + 2] = ((b + n / 2) / n) as u8;
            }
        }
    }
    Ok(RgbFrame {
        width: dst_w,
        height: dst_h,
        data: out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(width: u32, height: u32, layout: PixelLayout, pixels: &[[u8; 4]]) -> RawImage {
        RawImage {
            width,
            height,
            stride: width as usize * 4,
            layout,
            data: pixels.iter().flatten().copied().collect(),
        }
    }

    #[test]
    fn keeps_the_aspect_ratio_and_never_upscales() {
        assert_eq!(target_size(3840, 2160, 1280), (1280, 720));
        assert_eq!(target_size(800, 600, 1280), (800, 600));
        assert_eq!(target_size(3024, 1964, 960), (960, 623));
        assert_eq!(target_size(0, 10, 100), (0, 0));
    }

    #[test]
    fn averages_a_block_and_reads_the_layout() {
        // 2×2 BGRA → 1×1: red channel averages 0,100,200,100 = 100.
        let picture = image(
            2,
            2,
            PixelLayout::Bgra,
            &[[10, 20, 0, 255], [10, 20, 100, 255], [10, 20, 200, 255], [10, 20, 100, 255]],
        );
        let frame = to_rgb_scaled(&picture, 1).unwrap();
        assert_eq!((frame.width, frame.height), (1, 1));
        assert_eq!(frame.data, vec![100, 20, 10]);

        let rgba = image(1, 1, PixelLayout::Rgba, &[[1, 2, 3, 4]]);
        assert_eq!(to_rgb_scaled(&rgba, 10).unwrap().data, vec![1, 2, 3]);
        let argb = image(1, 1, PixelLayout::Argb, &[[9, 1, 2, 3]]);
        assert_eq!(to_rgb_scaled(&argb, 10).unwrap().data, vec![1, 2, 3]);
    }

    #[test]
    fn refuses_a_picture_shorter_than_its_size() {
        let mut picture = image(2, 2, PixelLayout::Bgra, &[[0; 4]; 4]);
        picture.data.truncate(10);
        assert!(to_rgb_scaled(&picture, 2).is_err());
    }

    #[test]
    fn honours_a_padded_stride() {
        let picture = RawImage {
            width: 1,
            height: 2,
            stride: 8,
            layout: PixelLayout::Rgba,
            data: vec![1, 2, 3, 0, 9, 9, 9, 9, 4, 5, 6, 0],
        };
        let frame = to_rgb_scaled(&picture, 1).unwrap();
        assert_eq!(frame.data, vec![1, 2, 3, 4, 5, 6]);
    }
}
