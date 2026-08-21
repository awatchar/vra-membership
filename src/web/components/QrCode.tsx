import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/**
 * Renders the PromptPay payload as a QR the applicant can scan.
 *
 * Drawn in the browser, not on the server. The Worker produces the payload
 * string; rasterising it there would mean shipping an image encoder into a
 * bundle that already carries a PDF library, to send a picture of a string the
 * client already has.
 *
 * The output is an inline SVG rather than a canvas so it stays sharp at any
 * size, prints correctly, and needs no ref or effect to appear.
 */

export interface QrCodeProps {
  payload: string;
  /** Rendered size in CSS pixels. */
  size?: number;
  /** Described to a screen reader, which cannot read the code itself. */
  label: string;
}

/** Quiet zone, in modules. Below four the code becomes unreliable to scan. */
const MARGIN = 4;

export function QrCode({ payload, size = 240, label }: QrCodeProps) {
  const svg = useMemo(() => {
    // Type 0 lets the library pick the smallest version that fits, and level M
    // is the usual trade-off for a payment QR: enough recovery for a phone
    // camera at an angle without inflating the module count.
    const code = qrcode(0, 'M');
    code.addData(payload);
    code.make();

    const count = code.getModuleCount();
    const extent = count + MARGIN * 2;

    let path = '';
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        if (!code.isDark(row, column)) continue;
        path += `M${column + MARGIN} ${row + MARGIN}h1v1h-1z`;
      }
    }

    return { extent, path };
  }, [payload]);

  return (
    <svg
      className="vra-qr"
      width={size}
      height={size}
      viewBox={`0 0 ${svg.extent} ${svg.extent}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={svg.extent} height={svg.extent} fill="#ffffff" />
      <path d={svg.path} fill="#000000" />
    </svg>
  );
}
