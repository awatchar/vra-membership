import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/worker/lib/http';
import {
  hasJpegMetadata,
  readImageDimensions,
  stripJpegMetadata,
  verifyMemberPhoto,
} from '../../src/worker/lib/images';
import { makeJpeg, makeMemberPhoto, makePng, makeWebp } from '../support/images';

const GPS_MARKER = 'GPSLatitude=13.7563';

function contains(bytes: Uint8Array, needle: string): boolean {
  const haystack = new TextDecoder('latin1').decode(bytes);
  return haystack.includes(needle);
}

describe('readImageDimensions', () => {
  it('reads JPEG dimensions from the frame header', () => {
    expect(readImageDimensions(makeJpeg({ width: 600, height: 800 }), 'image/jpeg')).toEqual({
      width: 600,
      height: 800,
    });
  });

  it('reads JPEG dimensions past leading metadata segments', () => {
    // The frame header comes after APP1 and APP13, so the marker walk has to
    // skip them rather than assume a fixed offset.
    const jpeg = makeJpeg({
      width: 900,
      height: 1200,
      withExif: true,
      withPhotoshop: true,
      comment: 'a comment',
    });

    expect(readImageDimensions(jpeg, 'image/jpeg')).toEqual({ width: 900, height: 1200 });
  });

  it('reads PNG dimensions from IHDR', () => {
    expect(readImageDimensions(makePng(300, 400), 'image/png')).toEqual({
      width: 300,
      height: 400,
    });
  });

  it('reads lossy WebP dimensions', () => {
    expect(readImageDimensions(makeWebp(600, 800), 'image/webp')).toEqual({
      width: 600,
      height: 800,
    });
  });

  it('returns null for a truncated header', () => {
    expect(readImageDimensions(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg')).toBeNull();
    expect(readImageDimensions(new Uint8Array(4), 'image/png')).toBeNull();
  });

  it('returns null rather than a zero dimension', () => {
    expect(readImageDimensions(makeJpeg({ width: 0, height: 800 }), 'image/jpeg')).toBeNull();
  });
});

describe('hasJpegMetadata', () => {
  it('detects an EXIF segment', () => {
    expect(hasJpegMetadata(makeJpeg({ width: 600, height: 800, withExif: true }))).toBe(true);
  });

  it('detects a comment segment', () => {
    expect(hasJpegMetadata(makeJpeg({ width: 600, height: 800, comment: 'hi' }))).toBe(true);
  });

  it('reports none for a clean JPEG', () => {
    expect(hasJpegMetadata(makeJpeg({ width: 600, height: 800 }))).toBe(false);
  });
});

describe('stripJpegMetadata', () => {
  it('removes the EXIF payload', () => {
    const withExif = makeJpeg({ width: 600, height: 800, withExif: true });
    expect(contains(withExif, GPS_MARKER)).toBe(true);

    const stripped = stripJpegMetadata(withExif);

    // A phone photo can carry the coordinates of where it was taken. Attached
    // to a named applicant's face in a bucket, that is a location history.
    expect(contains(stripped, GPS_MARKER)).toBe(false);
    expect(contains(stripped, 'Exif')).toBe(false);
  });

  it('removes Photoshop and comment segments too', () => {
    const dirty = makeJpeg({
      width: 600,
      height: 800,
      withPhotoshop: true,
      comment: 'a caption that should not survive',
    });

    const stripped = stripJpegMetadata(dirty);

    expect(contains(stripped, 'Photoshop')).toBe(false);
    expect(contains(stripped, 'a caption that should not survive')).toBe(false);
  });

  it('leaves the image readable and the dimensions intact', () => {
    const stripped = stripJpegMetadata(
      makeJpeg({ width: 600, height: 800, withExif: true, scanPaddingBytes: 400 }),
    );

    expect(readImageDimensions(stripped, 'image/jpeg')).toEqual({ width: 600, height: 800 });
  });

  it('keeps the scan data byte for byte', () => {
    const clean = makeJpeg({ width: 600, height: 800, scanPaddingBytes: 400 });
    const dirty = makeJpeg({ width: 600, height: 800, withExif: true, scanPaddingBytes: 400 });

    // Stripping a dirty file must produce the same bytes as the clean one:
    // metadata gone, image untouched.
    expect(Array.from(stripJpegMetadata(dirty))).toEqual(Array.from(clean));
  });

  it('is a no-op on an already clean JPEG', () => {
    const clean = makeJpeg({ width: 600, height: 800, scanPaddingBytes: 200 });

    expect(Array.from(stripJpegMetadata(clean))).toEqual(Array.from(clean));
  });

  it('leaves a non-JPEG untouched', () => {
    const png = makePng(300, 400);
    expect(Array.from(stripJpegMetadata(png))).toEqual(Array.from(png));
  });
});

describe('verifyMemberPhoto', () => {
  it('accepts a full photo of adequate size', () => {
    const verified = verifyMemberPhoto(makeMemberPhoto(), 'image/jpeg');

    expect(verified.dimensions).toEqual({ width: 600, height: 800 });
    expect(verified.metadataStripped).toBe(false);
  });

  it('strips metadata and reports that it did', () => {
    const verified = verifyMemberPhoto(makeMemberPhoto({ withExif: true }), 'image/jpeg');

    expect(verified.metadataStripped).toBe(true);
    expect(contains(verified.bytes, GPS_MARKER)).toBe(false);
  });

  it('accepts other sizes within the safe bounds', () => {
    expect(
      verifyMemberPhoto(makeMemberPhoto({ width: 900, height: 1200 }), 'image/jpeg'),
    ).toBeTruthy();
    expect(
      verifyMemberPhoto(makeMemberPhoto({ width: 300, height: 400 }), 'image/jpeg'),
    ).toBeTruthy();
  });

  it('accepts square, landscape and portrait frames without cropping', () => {
    expect(
      verifyMemberPhoto(makeMemberPhoto({ width: 800, height: 800 }), 'image/jpeg'),
    ).toBeTruthy();
    expect(
      verifyMemberPhoto(makeMemberPhoto({ width: 800, height: 600 }), 'image/jpeg'),
    ).toBeTruthy();
    expect(
      verifyMemberPhoto(makeMemberPhoto({ width: 601, height: 800 }), 'image/jpeg'),
    ).toBeTruthy();
  });

  it('rejects a photo too small to print', () => {
    expect(() =>
      verifyMemberPhoto(makeMemberPhoto({ width: 150, height: 200 }), 'image/jpeg'),
    ).toThrow(ApiError);
  });

  it('accepts a decodable provider face below the upload print recommendation', () => {
    const verified = verifyMemberPhoto(makeMemberPhoto({ width: 150, height: 200 }), 'image/jpeg', {
      requirePrintMinimum: false,
    });

    expect(verified.dimensions).toEqual({ width: 150, height: 200 });
  });

  it('still rejects an implausibly large provider face when the minimum is disabled', () => {
    expect(() =>
      verifyMemberPhoto(makeMemberPhoto({ width: 3000, height: 4000 }), 'image/jpeg', {
        requirePrintMinimum: false,
      }),
    ).toThrow(ApiError);
  });

  it('rejects an implausibly large photo', () => {
    expect(() =>
      verifyMemberPhoto(makeMemberPhoto({ width: 3000, height: 4000 }), 'image/jpeg'),
    ).toThrow(ApiError);
  });

  it('rejects PNG and WebP, whose metadata this module does not rewrite', () => {
    // Accepting them would mean storing chunks that could carry EXIF or text.
    expect(() => verifyMemberPhoto(makePng(600, 800), 'image/png')).toThrow(ApiError);
    expect(() => verifyMemberPhoto(makeWebp(600, 800), 'image/webp')).toThrow(ApiError);
  });

  it('rejects bytes whose dimensions cannot be read', () => {
    expect(() => verifyMemberPhoto(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg')).toThrow(
      ApiError,
    );
  });

  it('never echoes image content in a rejection message', () => {
    try {
      verifyMemberPhoto(
        makeMemberPhoto({ width: 150, height: 200, comment: GPS_MARKER }),
        'image/jpeg',
      );
      expect.unreachable('verifyMemberPhoto should have thrown');
    } catch (error) {
      expect((error as ApiError).publicMessage).not.toContain(GPS_MARKER);
    }
  });
});
