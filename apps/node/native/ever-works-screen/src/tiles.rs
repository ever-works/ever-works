//! Changed-region streaming (FL-07 FR-5, FR-6, plan §3).
//!
//! The picture (already downscaled to the stream's width) is cut into 64 × 64
//! tiles; a tile whose bytes differ from the previous published picture is
//! JPEG-encoded on its own and sent in a `tiles` message whose payload is the
//! contracts' `TILES` layout, verbatim:
//!
//! ```text
//! [width u16][height u16][count u16]
//! count × { [x u16][y u16][w u16][h u16][len u32][JPEG] }
//! ```
//!
//! A full picture (`frame`) goes out on the keyframe cadence, on refresh, on a
//! display switch, and whenever most of the picture changed anyway. No publish
//! is ever larger than 512 KiB: a tiles batch is split, a keyframe re-encoded
//! at a lower quality until it fits.

use jpeg_encoder::{ColorType, Encoder};

/// Side of one tile, in picture pixels (contracts `FLEET_DESKTOP_TILE_SIZE`).
pub const TILE_SIZE: u32 = 64;

/// Largest single publish (contracts `FLEET_DESKTOP_MAX_PUBLISH_BYTES`).
pub const MAX_PUBLISH_BYTES: usize = 512 * 1024;

const TILES_HEADER_BYTES: usize = 6;
const TILE_HEADER_BYTES: usize = 12;

/// A tightly packed RGB picture (3 bytes per pixel, no row padding).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RgbFrame {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TileRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// Every tile of a `width × height` picture, row by row; edge tiles are smaller.
pub fn tile_grid(width: u32, height: u32) -> Vec<TileRect> {
    let mut out = Vec::new();
    let mut y = 0;
    while y < height {
        let h = TILE_SIZE.min(height - y);
        let mut x = 0;
        while x < width {
            let w = TILE_SIZE.min(width - x);
            out.push(TileRect { x, y, w, h });
            x += TILE_SIZE;
        }
        y += TILE_SIZE;
    }
    out
}

/// The tiles of `next` that differ from `prev` (every tile when the sizes differ).
pub fn changed_tiles(prev: &RgbFrame, next: &RgbFrame) -> Vec<TileRect> {
    let grid = tile_grid(next.width, next.height);
    if prev.width != next.width || prev.height != next.height || prev.data.len() != next.data.len()
    {
        return grid;
    }
    let row_bytes = next.width as usize * 3;
    grid.into_iter()
        .filter(|tile| {
            let start = tile.x as usize * 3;
            let end = start + tile.w as usize * 3;
            (tile.y..tile.y + tile.h).any(|row| {
                let offset = row as usize * row_bytes;
                prev.data[offset + start..offset + end] != next.data[offset + start..offset + end]
            })
        })
        .collect()
}

/// The RGB bytes of one tile.
pub fn extract(frame: &RgbFrame, rect: TileRect) -> Vec<u8> {
    let row_bytes = frame.width as usize * 3;
    let mut out = Vec::with_capacity(rect.w as usize * rect.h as usize * 3);
    for row in rect.y..rect.y + rect.h {
        let offset = row as usize * row_bytes + rect.x as usize * 3;
        out.extend_from_slice(&frame.data[offset..offset + rect.w as usize * 3]);
    }
    out
}

/// JPEG-encode a tightly packed RGB block.
pub fn encode_jpeg(rgb: &[u8], width: u32, height: u32, quality: u8) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 || width > u16::MAX as u32 || height > u16::MAX as u32 {
        return Err("picture size out of range".into());
    }
    let mut out = Vec::new();
    let encoder = Encoder::new(&mut out, quality.clamp(1, 100));
    encoder
        .encode(rgb, width as u16, height as u16, ColorType::Rgb)
        .map_err(|error| format!("jpeg: {error}"))?;
    Ok(out)
}

/// A `frame` payload: `[width u16][height u16][JPEG]`, re-encoded lower until it fits `max_bytes`.
pub fn frame_payload(frame: &RgbFrame, quality: u8, max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut q = quality.clamp(1, 100);
    loop {
        let jpeg = encode_jpeg(&frame.data, frame.width, frame.height, q)?;
        if jpeg.len() + 4 <= max_bytes {
            let mut out = Vec::with_capacity(jpeg.len() + 4);
            out.extend_from_slice(&(frame.width as u16).to_be_bytes());
            out.extend_from_slice(&(frame.height as u16).to_be_bytes());
            out.extend_from_slice(&jpeg);
            return Ok(out);
        }
        if q <= 15 {
            return Err("the picture does not fit one publish even at the lowest quality".into());
        }
        q = q.saturating_sub(15).max(15);
    }
}

/// Encode the changed tiles of `frame` into one or more `tiles` payloads, none over `max_bytes`.
pub fn tiles_payloads(
    frame: &RgbFrame,
    rects: &[TileRect],
    quality: u8,
    max_bytes: usize,
) -> Result<Vec<Vec<u8>>, String> {
    let mut payloads = Vec::new();
    let mut batch: Vec<(TileRect, Vec<u8>)> = Vec::new();
    let mut batch_bytes = TILES_HEADER_BYTES;
    for rect in rects {
        let jpeg = encode_jpeg(&extract(frame, *rect), rect.w, rect.h, quality)?;
        let size = TILE_HEADER_BYTES + jpeg.len();
        if TILES_HEADER_BYTES + size > max_bytes {
            return Err("one tile does not fit a publish".into());
        }
        if batch_bytes + size > max_bytes || batch.len() == u16::MAX as usize {
            payloads.push(pack(frame, &batch));
            batch.clear();
            batch_bytes = TILES_HEADER_BYTES;
        }
        batch_bytes += size;
        batch.push((*rect, jpeg));
    }
    if !batch.is_empty() {
        payloads.push(pack(frame, &batch));
    }
    Ok(payloads)
}

fn pack(frame: &RgbFrame, batch: &[(TileRect, Vec<u8>)]) -> Vec<u8> {
    let total: usize = TILES_HEADER_BYTES
        + batch
            .iter()
            .map(|(_, jpeg)| TILE_HEADER_BYTES + jpeg.len())
            .sum::<usize>();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&(frame.width as u16).to_be_bytes());
    out.extend_from_slice(&(frame.height as u16).to_be_bytes());
    out.extend_from_slice(&(batch.len() as u16).to_be_bytes());
    for (rect, jpeg) in batch {
        out.extend_from_slice(&(rect.x as u16).to_be_bytes());
        out.extend_from_slice(&(rect.y as u16).to_be_bytes());
        out.extend_from_slice(&(rect.w as u16).to_be_bytes());
        out.extend_from_slice(&(rect.h as u16).to_be_bytes());
        out.extend_from_slice(&(jpeg.len() as u32).to_be_bytes());
        out.extend_from_slice(jpeg);
    }
    out
}

/// Whether so much changed that a keyframe is cheaper than the tiles (more than half the grid).
pub fn mostly_changed(changed: usize, width: u32, height: u32) -> bool {
    let total = tile_grid(width, height).len();
    total > 0 && changed * 2 > total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: u32, height: u32, fill: u8) -> RgbFrame {
        RgbFrame {
            width,
            height,
            data: vec![fill; width as usize * height as usize * 3],
        }
    }

    #[test]
    fn an_unchanged_picture_has_no_tiles() {
        let a = frame(200, 130, 7);
        assert!(changed_tiles(&a, &a.clone()).is_empty());
    }

    #[test]
    fn one_changed_pixel_is_exactly_one_tile() {
        let a = frame(200, 130, 7);
        let mut b = a.clone();
        // Pixel (70, 65) lies in tile column 1, row 1.
        let offset = (65 * 200 + 70) * 3;
        b.data[offset] = 8;
        assert_eq!(
            changed_tiles(&a, &b),
            vec![TileRect {
                x: 64,
                y: 64,
                w: 64,
                h: 64
            }]
        );
    }

    #[test]
    fn a_full_change_is_every_tile_and_edges_are_smaller() {
        let a = frame(200, 130, 7);
        let b = frame(200, 130, 9);
        let changed = changed_tiles(&a, &b);
        assert_eq!(changed.len(), 4 * 3);
        assert!(changed.contains(&TileRect {
            x: 192,
            y: 128,
            w: 8,
            h: 2
        }));
        assert!(mostly_changed(changed.len(), 200, 130));
        assert_eq!(changed_tiles(&frame(10, 10, 0), &b).len(), 12);
    }

    #[test]
    fn extracts_a_tile_row_by_row() {
        let mut f = frame(3, 2, 0);
        for (i, byte) in f.data.iter_mut().enumerate() {
            *byte = i as u8;
        }
        let tile = extract(
            &f,
            TileRect {
                x: 1,
                y: 0,
                w: 2,
                h: 2,
            },
        );
        assert_eq!(tile, vec![3, 4, 5, 6, 7, 8, 12, 13, 14, 15, 16, 17]);
    }

    #[test]
    fn tiles_payload_matches_the_contract_layout() {
        let f = frame(128, 64, 100);
        let rects = vec![
            TileRect {
                x: 0,
                y: 0,
                w: 64,
                h: 64,
            },
            TileRect {
                x: 64,
                y: 0,
                w: 64,
                h: 64,
            },
        ];
        let payloads = tiles_payloads(&f, &rects, 50, MAX_PUBLISH_BYTES).unwrap();
        assert_eq!(payloads.len(), 1);
        let p = &payloads[0];
        assert_eq!(u16::from_be_bytes([p[0], p[1]]), 128);
        assert_eq!(u16::from_be_bytes([p[2], p[3]]), 64);
        assert_eq!(u16::from_be_bytes([p[4], p[5]]), 2);
        assert_eq!(u16::from_be_bytes([p[6], p[7]]), 0);
        let len = u32::from_be_bytes([p[14], p[15], p[16], p[17]]) as usize;
        assert_eq!(&p[18..20], &[0xff, 0xd8]);
        let second = 18 + len;
        assert_eq!(u16::from_be_bytes([p[second], p[second + 1]]), 64);
    }

    #[test]
    fn splits_batches_and_never_publishes_over_the_cap() {
        let f = frame(256, 256, 30);
        let rects = tile_grid(256, 256);
        let one = tiles_payloads(&f, &rects[..1], 90, MAX_PUBLISH_BYTES).unwrap()[0].len();
        let cap = TILES_HEADER_BYTES + 3 * (one - TILES_HEADER_BYTES);
        let payloads = tiles_payloads(&f, &rects, 90, cap).unwrap();
        assert!(payloads.len() >= 5);
        assert!(payloads.iter().all(|p| p.len() <= cap));
        let total: usize = payloads
            .iter()
            .map(|p| u16::from_be_bytes([p[4], p[5]]) as usize)
            .sum();
        assert_eq!(total, rects.len());
    }

    #[test]
    fn a_keyframe_fits_the_publish_cap() {
        let mut f = frame(640, 360, 0);
        for (i, byte) in f.data.iter_mut().enumerate() {
            *byte = (i.wrapping_mul(2_654_435_761) >> 13) as u8;
        }
        let payload = frame_payload(&f, 90, MAX_PUBLISH_BYTES).unwrap();
        assert!(payload.len() <= MAX_PUBLISH_BYTES);
        assert_eq!(u16::from_be_bytes([payload[0], payload[1]]), 640);
        assert_eq!(&payload[4..6], &[0xff, 0xd8]);
    }
}
