# LLD-11 — Clients

All clients reuse the LibreChat web UI of the tenant (`https://<slug>.<domain>`). We do not build a second chat UI.

## 1. Web (phase 1)

- Use LibreChat's own UI. Verify PWA install support (manifest and service worker) on the pinned version; if it is missing, inject the manifest through Traefik-served static files (no core change).
- Branding per tenant: logo, colours and app title through LibreChat env/config options where available (verify `APP_TITLE`, custom logo options).
- A "My account" link to the console user portal from the LibreChat interface (custom footer or menu link; verify options).

## 2. Desktop: Windows and macOS (phase 2)

| Item | Design |
| --- | --- |
| Framework | **Tauri v2** (Rust shell + system WebView). Fallback: Electron, if WebView issues appear with LibreChat |
| What it is | A thin shell that opens the tenant URL (asked at first run, or from a provisioning file via MDM) |
| Native extras | Tray icon; global shortcut (e.g. Ctrl/Cmd+Shift+Space) opens a quick-ask window; notifications; drag-and-drop files into chat; auto-start option |
| Updates | Tauri updater with signed update manifests hosted on our CDN |
| Signing | Windows: OV/EV code-signing certificate; macOS: Developer ID + notarisation |
| Distribution | MSI/EXE with silent install flags (Intune/GPO); DMG/PKG for macOS (Jamf/Intune) |
| Security | Navigation allowlist (tenant domain + Keycloak domain only); no Node/Rust APIs exposed to the web content except a minimal, typed bridge for shortcut/notification |

## 3. Mobile (phase 2–3)

1. PWA first (add to home screen).
2. Then a **Capacitor** wrapper for the App Store and Google Play: push notifications (Studio approvals, budget alerts), share-sheet "send to SME AI", camera upload.
3. Check App Store rules for AI chat apps (content moderation, account deletion in-app, which links to the user portal privacy page).

## 4. Office and Teams add-ins (phase 3)

- **Outlook add-in** (Office.js): a task pane that loads a slim route of our console (`/addin/outlook`). That route:
  - reads the selected e-mail (subject, body, with consent);
  - calls the gateway through console-api on behalf of the user (OIDC);
  - offers actions: summarise, draft reply, extract tasks;
  - inserts the result into a reply.
- **Word/Excel add-ins:** same pattern (summarise or rewrite the selection; explain a formula).
- **Teams app:** a personal tab that loads the tenant LibreChat. Later, a bot through the Microsoft 365 Agents SDK (verify licence and hosting needs).
- **Distribution:** centralised deployment through the Microsoft 365 admin center (customer IT), using a manifest with our domains.

## 5. Acceptance criteria (per phase)

- **Phase 2 desktop:** a signed installer installs silently and opens the tenant after SSO. The global shortcut works on Windows 11 and macOS 14+. An auto-update from v1.0.0 to v1.0.1 succeeds.
- **Phase 3 Outlook:** the "Draft reply" round-trip finishes in under 10 seconds on `fast`, with usage metered under the user.
