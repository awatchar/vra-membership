import logoUrl from '../assets/vra-logo.png';

/**
 * The band at the top of every page, on both halves of the site.
 *
 * It exists because neither half said whose system it was. Someone following a
 * link to apply is about to type a citizen ID and transfer money, and the only
 * thing identifying the association was the browser tab's title. For a page
 * asking for that, saying who you are is a security property rather than
 * decoration - it is the thing a person checks before deciding to trust a form.
 *
 * The logo has a real `alt`, not `""`. It is not decorative here: it is one of
 * the two things on the page that identify the association, so a screen reader
 * user needs it named.
 */

export interface SiteHeaderProps {
  associationName: string;
  /** Shown under the name, e.g. the manager portal's own label. */
  subtitle?: string;
  /** Right-hand slot, used by the portal for the signed-in manager. */
  aside?: React.ReactNode;
}

export function SiteHeader({ associationName, subtitle, aside }: SiteHeaderProps) {
  return (
    <header className="vra-site-header">
      <img
        className="vra-site-header__logo"
        src={logoUrl}
        // Intrinsic size given so the header does not reflow once it loads.
        width={48}
        height={48}
        alt={`ตราสัญลักษณ์${associationName}`}
      />

      <div className="vra-site-header__text">
        <p className="vra-site-header__name">{associationName}</p>
        {subtitle ? <p className="vra-site-header__subtitle">{subtitle}</p> : null}
      </div>

      {aside ? <div className="vra-site-header__aside">{aside}</div> : null}
    </header>
  );
}
