// SPDX-License-Identifier: AGPL-3.0-only
import { User, WebStorageStateStore } from 'oidc-client-ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from 'react-oidc-context';
import { App } from './App';
import { loadConfig } from './config';
import i18n from './i18n';
import { safeReturnPath } from './return-path';
import './index.css';

const config = await loadConfig();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider
      authority={config.authority}
      client_id={config.clientId}
      redirect_uri={`${window.location.origin}/callback`}
      post_logout_redirect_uri={window.location.origin}
      // The tenant comes from this claim, which Keycloak only adds when asked (LLD-02 §1.1).
      scope="openid organization"
      automaticSilentRenew
      // Would need an iframe from Keycloak, which the content security policy forbids.
      monitorSession={false}
      userStore={new WebStorageStateStore({ store: window.sessionStorage })}
      extraQueryParams={{ ui_locales: i18n.language }}
      onSigninCallback={(user: User | undefined) => {
        window.history.replaceState({}, document.title, safeReturnPath(user?.state));
      }}
    >
      <App config={config} />
    </AuthProvider>
  </StrictMode>,
);
