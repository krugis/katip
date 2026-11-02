// SPDX-License-Identifier: AGPL-3.0-only
import { Refine, type I18nProvider } from '@refinedev/core';
import routerProvider from '@refinedev/react-router';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from 'react-oidc-context';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { apiFetch, ApiError, type GetToken, type Me } from './api';
import { ALL_AREAS, canOpen, homeOf } from './areas';
import { LanguageSwitch, Shell } from './components/Shell';
import { Message } from './components/ui';
import type { AppConfig } from './config';
import { dataProviderFor } from './data-provider';
import { setLanguage, type Language } from './i18n';
import { AccountProblem, ComingSoon, NoAccess, ProviderTenants } from './pages';
import { TenantAccessRules } from './access-page';
import {
  DepartmentOverview,
  DepartmentRequests,
  DepartmentUsage,
  DepartmentUsers,
} from './department-page';
import { TenantPolicies } from './policy-page';
import { TenantUsage } from './usage-page';
import { TenantDepartments, TenantOverview, TenantUsers } from './tenant-pages';

const SCREENS: Record<string, (me: Me, getToken: GetToken) => React.ReactNode> = {
  '/provider/tenants': () => <ProviderTenants />,
  '/tenant/overview': (me, getToken) => <TenantOverview me={me} getToken={getToken} />,
  '/tenant/users': (me, getToken) => <TenantUsers me={me} getToken={getToken} />,
  '/tenant/departments': (me) => <TenantDepartments me={me} />,
  '/tenant/policies': (me, getToken) => <TenantPolicies me={me} getToken={getToken} />,
  '/tenant/access': (me, getToken) => <TenantAccessRules me={me} getToken={getToken} />,
  '/tenant/usage': (me, getToken) => <TenantUsage me={me} getToken={getToken} />,
  '/department/overview': (me, getToken) => <DepartmentOverview me={me} getToken={getToken} />,
  '/department/users': (me, getToken) => <DepartmentUsers me={me} getToken={getToken} />,
  '/department/usage': (me, getToken) => <DepartmentUsage me={me} getToken={getToken} />,
  '/department/requests': (me, getToken) => <DepartmentRequests me={me} getToken={getToken} />,
};

function Loading() {
  const { t } = useTranslation();
  return (
    <p className="px-4 py-16 text-center text-sm text-muted" role="status">
      {t('app.loading')}
    </p>
  );
}

function CurrentScreen({ me, getToken }: { me: Me; getToken: GetToken }) {
  const { pathname } = useLocation();
  const home = homeOf(me);
  if (pathname === '/' || pathname === '/callback') {
    return home ? <Navigate to={home} replace /> : <NoAccess home={null} />;
  }
  if (!canOpen(me, pathname)) return <NoAccess home={home} />;
  const screen = SCREENS[pathname];
  if (screen) return screen(me, getToken);
  const item = ALL_AREAS.flatMap((a) => a.items).find((i) => i.path === pathname);
  return <ComingSoon labelKey={item?.labelKey ?? 'page.soonTitle'} />;
}

function Signed({ config, getToken }: { config: AppConfig; getToken: GetToken }) {
  const auth = useAuth();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch<Me>('/me', getToken),
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
  });

  // A token the API no longer accepts: go through sign-in again.
  const signingIn = useRef(false);
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401 && !signingIn.current) {
      signingIn.current = true;
      void auth.signinRedirect();
    }
  }, [me.error, auth]);

  if (me.isLoading) return <Loading />;
  if (me.error || !me.data) {
    const code = me.error instanceof ApiError ? me.error.code : 'unavailable';
    return (
      <>
        <div className="flex justify-end px-4 py-2">
          <LanguageSwitch />
        </div>
        <AccountProblem
          code={code}
          onRetry={() => void me.refetch()}
          onSignOut={() => void auth.signoutRedirect()}
        />
      </>
    );
  }
  const slug = me.data.tenant?.slug;
  return (
    <Shell
      me={me.data}
      chatUrl={slug ? `https://${slug}.${config.baseDomain}` : null}
      onSignOut={() => void auth.signoutRedirect()}
    >
      <Routes>
        <Route path="*" element={<CurrentScreen me={me.data} getToken={getToken} />} />
      </Routes>
    </Shell>
  );
}

function Authenticated({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const { t, i18n } = useTranslation();
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = auth.user?.access_token ?? null;
  const getToken = useCallback<GetToken>(async () => tokenRef.current, []);
  const dataProvider = useMemo(() => dataProviderFor(getToken), [getToken]);
  const i18nProvider = useMemo<I18nProvider>(
    () => ({
      translate: (key, options) => t(key, options as Record<string, unknown>) as string,
      changeLocale: async (language) => setLanguage(language as Language),
      getLocale: () => i18n.language,
    }),
    [t, i18n.language],
  );
  return (
    <Refine
      dataProvider={dataProvider}
      i18nProvider={i18nProvider}
      routerProvider={routerProvider}
      options={{ disableTelemetry: true, reactQuery: { clientConfig: { defaultOptions: {} } } }}
    >
      <Signed config={config} getToken={getToken} />
    </Refine>
  );
}

export function App({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const { t } = useTranslation();
  const redirecting = useRef(false);

  useEffect(() => {
    if (auth.isLoading || auth.isAuthenticated || auth.error || redirecting.current) return;
    redirecting.current = true;
    const returnTo = window.location.pathname + window.location.search;
    void auth.signinRedirect({ state: { returnTo } });
  }, [auth]);

  if (auth.error) {
    return (
      <Message title={t('problem.title')} testId="account-problem">
        <p data-testid="problem-code" data-code="signInFailed">
          {t('problem.signInFailed')}
        </p>
        <a className="text-accent underline underline-offset-2" href="/">
          {t('problem.retry')}
        </a>
      </Message>
    );
  }
  if (!auth.isAuthenticated) return <Loading />;
  return (
    <BrowserRouter>
      <Authenticated config={config} />
    </BrowserRouter>
  );
}
