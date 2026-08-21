import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AdminApp } from './admin/AdminApp';
import { PrivacyNotice } from './privacy/PrivacyNotice';
import './styles/global.css';
import './styles/wizard.css';
import './styles/admin.css';

/**
 * One bundle, two applications, chosen by path.
 *
 * `/admin*` is the manager's portal and everything else is the applicant wizard.
 * They share a bundle because they share the components and the stylesheet, and
 * because splitting them would mean a second build for a site that serves one or
 * two applications a day. They share no data: the portal never renders while the
 * wizard does, and the wizard holds no admin state.
 *
 * The portal is only reachable through Cloudflare Access, which sits in front of
 * `/admin*`, and every request it makes is verified again by the Worker. Shipping
 * its code to a browser that has not passed Access is harmless - the code can
 * read nothing without a token.
 */
const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container is missing from index.html');
}

const isAdmin =
  window.location.pathname.replace(/\/+$/, '') === '/admin' ||
  window.location.pathname.startsWith('/admin/');
const isPrivacyNotice = window.location.pathname.replace(/\/+$/, '') === '/privacy';

createRoot(container).render(
  <StrictMode>{isAdmin ? <AdminApp /> : isPrivacyNotice ? <PrivacyNotice /> : <App />}</StrictMode>,
);
