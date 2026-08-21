import { useCallback, useEffect, useState } from 'react';
import { Alert } from '../components/Alert';
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

export function AdminApp() {
  const [route, setRoute] = useState<AdminRoute>(() => parseAdminRoute(window.location.pathname));
  const [session, setSession] = useState<AdminSession | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (error) {
    return (
      <main className="vra-admin">
        <Alert tone="error" title="เข้าถึงระบบผู้จัดการไม่ได้">
          <p>{error}</p>
          <p>
            หากเพิ่งเข้าสู่ระบบ กรุณาโหลดหน้านี้อีกครั้ง หากยังเข้าไม่ได้
            กรุณาตรวจสอบว่าบัญชีของท่านได้รับสิทธิ์ในระบบ Cloudflare Access แล้ว
          </p>
        </Alert>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="vra-admin">
        <p className="vra-muted">กำลังตรวจสอบสิทธิ์...</p>
      </main>
    );
  }

  return (
    <main className="vra-admin">
      <header className="vra-admin__header">
        <p className="vra-admin__brand">ระบบผู้จัดการ · สมาคมนักวิทยุอาสาสมัคร</p>
        <p className="vra-admin__manager">{session.manager.email}</p>
      </header>

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
    </main>
  );
}
