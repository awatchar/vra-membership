import { useCallback, useEffect, useState } from 'react';
import { Alert } from '../components/Alert';
import { SiteFooter } from '../components/SiteFooter';
import { SiteHeader } from '../components/SiteHeader';
import { api } from '../api/client';
import type { AssociationContact } from '../api/types';
import { adminApi } from './api';
import type { AdminSession } from './api';
import { ConfirmPage } from './ConfirmPage';
import { DetailPage } from './DetailPage';
import { QueuePage } from './QueuePage';
import { parseAdminRoute, queuePath } from './route';
import type { AdminRoute } from './route';

/**
 * The manager's portal.
 *
 * Everything here sits behind Cloudflare Access, and the Worker verifies the
 * token again on every request (see `src/worker/security/access.ts`). The first
 * thing this does is call `GET /api/admin/session`, which both proves the caller
 * is authenticated and hands back the CSRF token every state change has to carry
 * - Access authenticates with a cookie, and a cookie travels on cross-site
 * requests too.
 *
 * If that call fails, no page renders. There is no partly-usable state: without
 * a CSRF token nothing can be confirmed anyway, and rendering a portal that
 * looks working while every action fails is worse than saying so.
 *
 * Routing is `history.pushState` over a handful of paths, with no router
 * dependency. The three action paths are the ones the manager notification email
 * links to, so they have to be real URLs that survive being opened from a mail
 * client - and the pages they land on must do nothing on their own.
 */

/** Same fallback as the wizard: a name, and no invented contact details. */
const FALLBACK_ASSOCIATION: AssociationContact = {
  name: 'สมาคมนักวิทยุอาสาสมัคร',
  postalAddress: null,
  email: null,
  lineId: null,
  phone: null,
};

export function AdminApp() {
  const [route, setRoute] = useState<AdminRoute>(() => parseAdminRoute(window.location.pathname));
  const [session, setSession] = useState<AdminSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [association, setAssociation] = useState<AssociationContact>(FALLBACK_ASSOCIATION);

  // `/api/config` is public and needs no Access, so the header and footer are
  // right even on the page that says the manager could not be authenticated -
  // which is the page they most need a contact address on.
  useEffect(() => {
    api
      .config()
      .then((config) => setAssociation(config.association))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    adminApi
      .session()
      .then(setSession)
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error ? caught.message : 'ไม่สามารถยืนยันสิทธิ์เข้าถึงระบบผู้จัดการได้',
        );
      });
  }, []);

  // The back button has to work: a manager moves between the queue and a detail
  // constantly, and a portal where back leaves the app is one they will stop
  // using.
  useEffect(() => {
    const onPopState = () => setRoute(parseAdminRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, '', path);
    setRoute(parseAdminRoute(path));
    window.scrollTo({ top: 0 });
  }, []);

  const toQueue = useCallback(() => navigate(queuePath()), [navigate]);

  const frame = (children: React.ReactNode, aside?: React.ReactNode) => (
    <div className="vra-page">
      <SiteHeader
        associationName={association.name}
        subtitle="ระบบผู้จัดการ"
        {...(aside ? { aside } : {})}
      />
      <main className="vra-admin">{children}</main>
      <SiteFooter contact={association} />
    </div>
  );

  if (error) {
    return frame(
      <Alert tone="error" title="เข้าถึงระบบผู้จัดการไม่ได้">
        <p>{error}</p>
        <p>
          หากเพิ่งเข้าสู่ระบบ กรุณาโหลดหน้านี้อีกครั้ง หากยังเข้าไม่ได้
          กรุณาตรวจสอบว่าบัญชีของท่านได้รับสิทธิ์ในระบบ Cloudflare Access แล้ว
        </p>
      </Alert>,
    );
  }

  if (!session) {
    return frame(<p className="vra-muted">กำลังตรวจสอบสิทธิ์...</p>);
  }

  return frame(
    <>
      {route.kind === 'queue' ? <QueuePage onOpen={navigate} /> : null}

      {route.kind === 'detail' ? (
        <DetailPage
          applicationId={route.applicationId}
          csrf={session.csrf}
          onOpen={navigate}
          onBack={toQueue}
        />
      ) : null}

      {route.kind === 'acknowledge' || route.kind === 'nbtc-complete' ? (
        <ConfirmPage
          action={route.kind}
          applicationId={route.applicationId}
          csrf={session.csrf}
          onDone={navigate}
          onCancel={() => navigate(`/admin/applications/${route.applicationId}`)}
        />
      ) : null}

      {route.kind === 'unknown' ? (
        <Alert tone="error" title="ไม่พบหน้านี้">
          <p>ที่อยู่ที่เปิดไม่ตรงกับหน้าใดในระบบผู้จัดการ</p>
          <button type="button" className="vra-back" onClick={toQueue}>
            ← ไปรายการใบสมัคร
          </button>
        </Alert>
      ) : null}
    </>,
    <span className="vra-admin__manager">{session.manager.email}</span>,
  );
}
