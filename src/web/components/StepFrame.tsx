import type { ReactNode } from 'react';
import { STEP_TITLES, stepPosition } from '../state/wizard';
import type { WizardStep } from '../state/wizard';

/**
 * The frame every step is rendered inside.
 *
 * The heading is an `<h1>` that changes per step, and it is focusable and
 * focused on entry by the caller - on a single-page wizard nothing announces a
 * step change otherwise, so a screen reader user pressing "next" hears silence
 * and has to hunt for what moved.
 *
 * Progress is text as well as a bar. "ขั้นที่ 4 จาก 9" is readable; a filled bar
 * alone is not.
 */

export interface StepFrameProps {
  step: WizardStep;
  /** Shown under the heading. */
  intro?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  headingRef?: React.Ref<HTMLHeadingElement>;
}

export function StepFrame({ step, intro, children, footer, headingRef }: StepFrameProps) {
  const { index, total } = stepPosition(step);
  const percent = Math.round((index / total) * 100);

  return (
    <section className="vra-step" aria-labelledby="vra-step-heading">
      <div className="vra-progress">
        <p className="vra-progress__text">
          ขั้นที่ {index} จาก {total}
        </p>
        <div
          className="vra-progress__track"
          role="progressbar"
          aria-valuenow={index}
          aria-valuemin={1}
          aria-valuemax={total}
          aria-label="ความคืบหน้าการสมัคร"
        >
          <div className="vra-progress__bar" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <h1 className="vra-step__title" id="vra-step-heading" tabIndex={-1} ref={headingRef}>
        {STEP_TITLES[step]}
      </h1>

      {intro ? <div className="vra-step__intro">{intro}</div> : null}

      <div className="vra-step__body">{children}</div>

      {footer ? <div className="vra-step__footer">{footer}</div> : null}
    </section>
  );
}
