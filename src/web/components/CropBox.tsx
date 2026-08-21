import { useCallback, useEffect, useRef, useState } from 'react';
import type { CropRegion } from '../lib/image';

/**
 * Choosing the square that becomes the member photo.
 *
 * The control is a zoom slider plus a draggable image, and both are reachable
 * without a pointer: the slider is a native `<input type="range">`, and the
 * arrow keys nudge the crop centre when the frame has focus. A drag-only crop
 * control is unusable with a keyboard and awkward with a screen reader, and this
 * is a step nobody can skip.
 *
 * The region is kept in fractions of the source image, so the preview can be
 * whatever size fits the screen while the crop still applies to the original
 * pixels (see `cropToSquare`).
 */

/** How far one arrow-key press moves the centre, as a fraction. */
const NUDGE = 0.02;

export interface CropBoxProps {
  imageUrl: string;
  region: CropRegion;
  onChange: (region: CropRegion) => void;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function CropBox({ imageUrl, region, onChange }: CropBoxProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const moveTo = useCallback(
    (clientX: number, clientY: number) => {
      const frame = frameRef.current;
      if (!frame) return;
      const bounds = frame.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0) return;

      onChange({
        ...region,
        x: clamp((clientX - bounds.left) / bounds.width),
        y: clamp((clientY - bounds.top) / bounds.height),
      });
    },
    [onChange, region],
  );

  useEffect(() => {
    if (!dragging) return;

    const onPointerMove = (event: PointerEvent) => {
      event.preventDefault();
      moveTo(event.clientX, event.clientY);
    };
    const stop = () => setDragging(false);

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [dragging, moveTo]);

  return (
    <div className="vra-crop">
      <div
        ref={frameRef}
        className="vra-crop__frame"
        role="application"
        aria-label="ปรับตำแหน่งรูป ใช้ปุ่มลูกศรเพื่อเลื่อน และแถบด้านล่างเพื่อย่อขยาย"
        tabIndex={0}
        onPointerDown={(event) => {
          setDragging(true);
          moveTo(event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          const step: Partial<Record<string, [number, number]>> = {
            ArrowLeft: [-NUDGE, 0],
            ArrowRight: [NUDGE, 0],
            ArrowUp: [0, -NUDGE],
            ArrowDown: [0, NUDGE],
          };
          const delta = step[event.key];
          if (!delta) return;
          event.preventDefault();
          onChange({ ...region, x: clamp(region.x + delta[0]), y: clamp(region.y + delta[1]) });
        }}
      >
        <img className="vra-crop__image" src={imageUrl} alt="" draggable={false} />
        <div
          className="vra-crop__window"
          style={{
            width: `${region.size * 100}%`,
            left: `${region.x * 100}%`,
            top: `${region.y * 100}%`,
          }}
          aria-hidden="true"
        />
      </div>

      <label className="vra-crop__zoom">
        <span className="vra-field__label">ขนาดกรอบ</span>
        <input
          type="range"
          min={20}
          max={100}
          step={5}
          value={Math.round(region.size * 100)}
          onChange={(event) => onChange({ ...region, size: Number(event.target.value) / 100 })}
        />
      </label>
    </div>
  );
}
