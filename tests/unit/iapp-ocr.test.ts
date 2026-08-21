import { describe, expect, it } from 'vitest';
import { parseIappEnglishDate } from '../../src/worker/providers/iapp/dates';
import { createIappOcrProvider, mapIappFrontResponse } from '../../src/worker/providers/iapp';

/**
 * A realistic iApp front-side response, using the field names and formats from
 * the published contract. Every value is synthetic.
 *
 * It deliberately includes the fields that must NOT survive the mapping -
 * religion, gender, issue date, postal code, confidence, bbox - so a future
 * change that starts passing them through fails a test.
 */
const IAPP_RESPONSE = {
  id_number: '1234567890121',
  th_init: 'นาย',
  th_fname: 'ทดสอบ',
  th_lname: 'ระบบสมัคร',
  en_init: 'Mr.',
  en_fname: 'Thodsob',
  en_lname: 'Rabobsamak',
  th_dob: '15 ม.ค. 2533',
  en_dob: '15 Jan 1990',
  th_issue: '20 ก.ค. 2565',
  en_issue: '20 Jul 2022',
  th_expire: '14 ม.ค. 2575',
  en_expire: '14 Jan 2032',
  address: '999 หมู่ 9 ต.ตัวอย่าง อ.ตัวอย่าง จ.กรุงเทพมหานคร',
  house_no: '999',
  village_no: '9',
  sub_district: 'ตัวอย่าง',
  district: 'ตัวอย่าง',
  province: 'กรุงเทพมหานคร',
  postal_code: '10200',
  religion: 'พุทธ',
  gender: 'ชาย',
  // A one-pixel JPEG is enough to prove the decode path.
  face: '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAg=',
  detection_score: 0.98,
  process_time: 1.23,
  request_id: null,
  confidence: { id_number: 0.99, th_name: 0.97 },
  bbox: { id_number: [1, 2, 3, 4] },
};

describe('parseIappEnglishDate', () => {
  it('parses the documented format', () => {
    expect(parseIappEnglishDate('26 Jul 2016')).toBe('2016-07-26');
  });

  it('parses a single-digit day', () => {
    expect(parseIappEnglishDate('1 Jan 1990')).toBe('1990-01-01');
  });

  it('accepts a full month name and a trailing dot', () => {
    expect(parseIappEnglishDate('15 January 1990')).toBe('1990-01-15');
    expect(parseIappEnglishDate('15 Jan. 1990')).toBe('1990-01-15');
  });

  it('returns null for a masked value', () => {
    // The published examples mask digits as XX; that is not a date.
    expect(parseIappEnglishDate('XX Mar 1957')).toBeNull();
  });

  it('returns null for a Thai Buddhist date, which is the wrong field', () => {
    expect(parseIappEnglishDate('15 ม.ค. 2533')).toBeNull();
  });

  it('returns null rather than shifting a date that does not exist', () => {
    // Date.UTC would silently turn 31 February into 3 March, and the applicant
    // might not notice a plausible-looking wrong date.
    expect(parseIappEnglishDate('31 Feb 1990')).toBeNull();
    expect(parseIappEnglishDate('32 Jan 1990')).toBeNull();
  });

  it('returns null for missing or non-string input', () => {
    expect(parseIappEnglishDate(undefined)).toBeNull();
    expect(parseIappEnglishDate(null)).toBeNull();
    expect(parseIappEnglishDate('')).toBeNull();
    expect(parseIappEnglishDate(19900115)).toBeNull();
  });
});

describe('mapIappFrontResponse', () => {
  it('maps the fields the membership process needs', () => {
    const data = mapIappFrontResponse(IAPP_RESPONSE);

    expect(data).toMatchObject({
      citizenId: '1234567890121',
      titleTh: 'นาย',
      firstNameTh: 'ทดสอบ',
      lastNameTh: 'ระบบสมัคร',
      firstNameEn: 'Thodsob',
      lastNameEn: 'Rabobsamak',
      birthDate: '1990-01-15',
      cardExpiryDate: '2032-01-14',
      subdistrict: 'ตัวอย่าง',
      district: 'ตัวอย่าง',
      province: 'กรุงเทพมหานคร',
    });
  });

  it('returns exactly the internal field set, nothing more', () => {
    const data = mapIappFrontResponse(IAPP_RESPONSE)!;

    expect(Object.keys(data).sort()).toEqual(
      [
        'addressLine',
        'birthDate',
        'cardExpiryDate',
        'citizenId',
        'district',
        'faceImage',
        'firstNameEn',
        'firstNameTh',
        'lastNameEn',
        'lastNameTh',
        'province',
        'subdistrict',
        'titleTh',
      ].sort(),
    );
  });

  it('drops religion, gender and the issue date', () => {
    // Issue #1 section 8: no business purpose, so no place to put them.
    const serialised = JSON.stringify(mapIappFrontResponse(IAPP_RESPONSE));

    expect(serialised).not.toContain('พุทธ');
    expect(serialised).not.toContain('ชาย');
    expect(serialised).not.toContain('2022');
  });

  it('never carries the postal code through', () => {
    // A Thai ID card does not print a postcode, so whatever iApp returns is
    // inferred. Issue #1 section 9.1 forbids deriving one from OCR; the
    // applicant enters it themselves.
    const data = mapIappFrontResponse(IAPP_RESPONSE)!;

    expect(JSON.stringify(data)).not.toContain('10200');
    expect(Object.keys(data)).not.toContain('postalCode');
  });

  it('drops confidence scores, bounding boxes and provider timings', () => {
    const serialised = JSON.stringify(mapIappFrontResponse(IAPP_RESPONSE));

    expect(serialised).not.toContain('detection_score');
    expect(serialised).not.toContain('confidence');
    expect(serialised).not.toContain('bbox');
    expect(serialised).not.toContain('process_time');
  });

  it('decodes the cropped face photo', () => {
    const data = mapIappFrontResponse(IAPP_RESPONSE)!;

    expect(data.faceImage).not.toBeNull();
    expect(data.faceImage!.contentType).toBe('image/jpeg');
    // JPEG magic bytes, so this really is an image and not a mangled string.
    expect(Array.from(data.faceImage!.bytes.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
  });

  it('tolerates a data URI in the face field', () => {
    const data = mapIappFrontResponse({
      ...IAPP_RESPONSE,
      face: `data:image/jpeg;base64,${IAPP_RESPONSE.face}`,
    })!;

    expect(Array.from(data.faceImage!.bytes.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
  });

  it('returns a null face rather than corrupt bytes for undecodable base64', () => {
    const data = mapIappFrontResponse({ ...IAPP_RESPONSE, face: 'not base64 !!!' })!;

    expect(data.faceImage).toBeNull();
  });

  it('strips the card formatting from the citizen ID', () => {
    const data = mapIappFrontResponse({ ...IAPP_RESPONSE, id_number: '1 2345 67890 12 1' })!;

    expect(data.citizenId).toBe('1234567890121');
  });

  it('returns null when there is no usable citizen ID', () => {
    expect(mapIappFrontResponse({ ...IAPP_RESPONSE, id_number: '' })).toBeNull();
    expect(mapIappFrontResponse({ ...IAPP_RESPONSE, id_number: undefined })).toBeNull();
    expect(mapIappFrontResponse({})).toBeNull();
    expect(mapIappFrontResponse(null)).toBeNull();
    expect(mapIappFrontResponse('a string')).toBeNull();
  });

  it('turns a blank field into null rather than an empty string', () => {
    const data = mapIappFrontResponse({ ...IAPP_RESPONSE, th_fname: '   ' })!;

    expect(data.firstNameTh).toBeNull();
  });

  it('leaves an unreadable date empty instead of failing the whole card', () => {
    // OCR output is a pre-fill the applicant corrects, so one bad field must
    // not cost them the other twelve.
    const data = mapIappFrontResponse({ ...IAPP_RESPONSE, en_dob: 'XX Mar 1957' })!;

    expect(data.birthDate).toBeNull();
    expect(data.citizenId).toBe('1234567890121');
  });
});

/**
 * Transport behaviour, exercised against a stub `fetch`. The real endpoint is
 * never called: automated tests must not reach iApp (AGENTS.md).
 */
describe('createIappOcrProvider', () => {
  const image = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]), contentType: 'image/jpeg' };

  function providerWith(handler: (request: Request) => Promise<Response> | Response) {
    const calls: Request[] = [];
    const provider = createIappOcrProvider({
      apiKey: 'test-only-key',
      endpoint: 'https://ocr.example.test/front',
    });
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request);
      return handler(request);
    };
    return { provider, calls, restore: () => (globalThis.fetch = original) };
  }

  it('sends the api key in the apikey header and the image as the file field', async () => {
    const { provider, calls, restore } = providerWith(
      () => new Response(JSON.stringify(IAPP_RESPONSE), { status: 200 }),
    );

    try {
      await provider.readThaiIdCardFront(image);

      const request = calls[0]!;
      expect(request.method).toBe('POST');
      expect(request.headers.get('apikey')).toBe('test-only-key');
      expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
      const form = await request.formData();
      const file = form.get('file');
      expect(file).toBeInstanceOf(File);
      if (!(file instanceof File)) throw new Error('expected multipart file');
      expect(file.name).toBe('front.jpg');
      expect(file.type).toBe('image/jpeg');
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(image.bytes);
      // Extra crops and bounding boxes are data with no purpose here, so they
      // are not requested at all.
      expect(form.get('options')).toBeNull();
    } finally {
      restore();
    }
  });

  it.each([
    ['image/jpeg', 'front.jpg'],
    ['image/png', 'front.png'],
    ['image/webp', 'front.webp'],
  ])('matches the neutral upload filename to %s', async (contentType, expectedFilename) => {
    const { provider, calls, restore } = providerWith(
      () => new Response(JSON.stringify(IAPP_RESPONSE), { status: 200 }),
    );

    try {
      await provider.readThaiIdCardFront({ ...image, contentType });

      const form = await calls[0]!.formData();
      const file = form.get('file');
      expect(file).toBeInstanceOf(File);
      if (!(file instanceof File)) throw new Error('expected multipart file');
      expect(file.name).toBe(expectedFilename);
      expect(file.type).toBe(contentType);
    } finally {
      restore();
    }
  });

  it('maps a successful response', async () => {
    const { provider, restore } = providerWith(
      () => new Response(JSON.stringify(IAPP_RESPONSE), { status: 200 }),
    );

    try {
      const result = await provider.readThaiIdCardFront(image);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.citizenId).toBe('1234567890121');
    } finally {
      restore();
    }
  });

  it.each([
    [420, 'NOT_A_THAI_ID_CARD'],
    [421, 'PROVIDER_REJECTED_IMAGE'],
    [422, 'PROVIDER_REJECTED_IMAGE'],
    [426, 'PROVIDER_REJECTED_IMAGE'],
    [413, 'PROVIDER_REJECTED_IMAGE'],
    [461, 'PROVIDER_REJECTED_IMAGE'],
    [424, 'UNREADABLE'],
    [425, 'UNREADABLE'],
    [427, 'PROVIDER_TIMEOUT'],
    [428, 'PROVIDER_TIMEOUT'],
  ])('maps HTTP %i to %s', async (status, reason) => {
    const { provider, restore } = providerWith(() => new Response('{}', { status }));

    try {
      await expect(provider.readThaiIdCardFront(image)).resolves.toEqual({
        ok: false,
        reason,
      });
    } finally {
      restore();
    }
  });

  it('degrades an unknown status to a generic provider error', async () => {
    const { provider, restore } = providerWith(() => new Response('{}', { status: 599 }));

    try {
      await expect(provider.readThaiIdCardFront(image)).resolves.toEqual({
        ok: false,
        reason: 'PROVIDER_ERROR',
      });
    } finally {
      restore();
    }
  });

  it('reports a network failure as a provider error', async () => {
    const { provider, restore } = providerWith(() => {
      throw new Error('connection reset');
    });

    try {
      await expect(provider.readThaiIdCardFront(image)).resolves.toEqual({
        ok: false,
        reason: 'PROVIDER_ERROR',
      });
    } finally {
      restore();
    }
  });

  it('treats an unparseable body as a provider error', async () => {
    const { provider, restore } = providerWith(() => new Response('not json', { status: 200 }));

    try {
      await expect(provider.readThaiIdCardFront(image)).resolves.toEqual({
        ok: false,
        reason: 'PROVIDER_ERROR',
      });
    } finally {
      restore();
    }
  });

  it('treats a 200 with no usable card number as unreadable', async () => {
    const { provider, restore } = providerWith(
      () => new Response(JSON.stringify({ detection_score: 0.1 }), { status: 200 }),
    );

    try {
      await expect(provider.readThaiIdCardFront(image)).resolves.toEqual({
        ok: false,
        reason: 'UNREADABLE',
      });
    } finally {
      restore();
    }
  });

  it('never puts the api key anywhere but the header', async () => {
    const { provider, calls, restore } = providerWith(
      () => new Response(JSON.stringify(IAPP_RESPONSE), { status: 200 }),
    );

    try {
      await provider.readThaiIdCardFront(image);

      const request = calls[0]!;
      expect(request.url).not.toContain('test-only-key');
      const form = await request.formData();
      for (const [, value] of form.entries()) {
        if (typeof value === 'string') expect(value).not.toContain('test-only-key');
      }
    } finally {
      restore();
    }
  });
});
