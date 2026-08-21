import type { AssociationContact } from '../api/types';

/**
 * Contact details, on every page.
 *
 * Not boilerplate. An applicant who gets stuck between transferring money and
 * seeing the confirmation has, without this, no way to reach anyone - and that
 * is exactly the moment they most need one. So the footer carries the post box,
 * the email, the LINE ID and the manager's phone number.
 *
 * Every line is optional and a missing value renders nothing. A footer that
 * shows a blank row, or an example value that looks real, is worse than a footer
 * with one fewer line: someone would try it.
 *
 * The values come from configuration rather than from this file, so a phone
 * number can change without a code review. The association's own contact
 * details are public information, which the owner has confirmed - unlike an
 * applicant's, which never appear here.
 */

export interface SiteFooterProps {
  contact: AssociationContact;
}

export function SiteFooter({ contact }: SiteFooterProps) {
  const { name, postalAddress, email, lineId, phone } = contact;

  return (
    <footer className="vra-site-footer">
      <p className="vra-site-footer__name">{name}</p>

      <dl className="vra-site-footer__details">
        {postalAddress ? (
          <div className="vra-site-footer__row">
            <dt>ที่อยู่</dt>
            <dd>{postalAddress}</dd>
          </div>
        ) : null}

        {email ? (
          <div className="vra-site-footer__row">
            <dt>อีเมล</dt>
            <dd>
              <a href={`mailto:${email}`}>{email}</a>
            </dd>
          </div>
        ) : null}

        {lineId ? (
          <div className="vra-site-footer__row">
            <dt>LINE ID</dt>
            <dd>{lineId}</dd>
          </div>
        ) : null}

        {phone ? (
          <div className="vra-site-footer__row">
            <dt>โทรศัพท์</dt>
            <dd>
              {/* `tel:` needs the digits without spaces; the label keeps them. */}
              <a href={`tel:${phone.replace(/\s+/g, '')}`}>{phone}</a>
            </dd>
          </div>
        ) : null}
      </dl>

      <p className="vra-site-footer__note">
        ระบบรับสมัครสมาชิกนี้เป็นระบบของ{name} ใช้เพื่อรับสมัครสมาชิกและบันทึกทะเบียนสมาชิกเท่านั้น
      </p>
    </footer>
  );
}
