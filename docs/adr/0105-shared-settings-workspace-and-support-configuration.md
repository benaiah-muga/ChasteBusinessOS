# ADR 0105: A shared settings workspace and support configuration

Date: 2026-10-31
Status: Accepted

## Context

The first composable app surface gave Customer support horizontal tabs and a
three-pane desk, but its settings were spread between Channels and the global
CBOS Settings page. The app had no Settings tab, so desk configuration did not
have a durable home inside the app. CBOS Settings itself was a single page with
a row of tabs. It had grown into nine unrelated sections, and the tab strip
could not show the relationship between workspace, governance, automation, and
platform controls.

ChasteDesk's settings page showed a better shape: one quiet, persistent index
on the left, a focused configuration column on the right, a page title and
status line above both, and small descriptions that explain what each section
owns. The requested outcome was not a visual copy. It was a settings anatomy
that a person can scan, that can grow without becoming a tab strip, and that an
app can reuse instead of inventing a second settings chrome.

## Decision

### 1. One shared settings anatomy

Introduce `SettingsWorkspace`, a layout component used by CBOS Settings and by
the support app. It owns:

- the eyebrow, page title, and optional lede or status line;
- grouped section links with an icon, label, and short ownership description;
- the active-section header above the configuration content;
- a footer note for the settings' authority boundary;
- desktop left index and mobile horizontal index behavior.

The component has no data-fetching or write logic. Each owning page supplies its
sections and the actual governed controls. The left index is navigation, not a
tablist: each section is a link on CBOS Settings and a local section control in
the support app.

### 2. CBOS Settings sections are URL-addressable

CBOS Settings maps nine sections into three groups:

- General: Workspace, Email, Notifications
- AI & automation: AI providers, Agent, Routines
- Operations: Modules, Governance, Runtime

The access links that used to sit in the settings index are gone. Team & access
lives inside Workspace, and the audit ledger stays in the global workspace rail.
Email and Agent are exposed as first-class sections instead of being buried
inside Workspace or AI. Workspace keeps its related views local: Overview and
Print branding. Governance keeps Policy and Quality local. The local views use a
small segmented control rather than adding more entries to the left index.

Selecting a section updates `/settings/<section>`. The shell accepts those
subpaths, the page derives its active section from the pathname, and browser
back and forward work. `/settings` opens Workspace. The page header and section
header are distinct: "Settings" is the page, "Modules" or "Governance" is the
current configuration area.

The old horizontal tab strip is removed. Existing settings panels are reused, so
the layout change does not alter their governed writes, approval handling, or
retry behavior.

### 3. Type and accent balance

The page uses a 42px display title, a 29px section title, 12px navigation and
body copy, and 11px supporting copy. The CBOS page lede and status strip are
removed; the support Settings page keeps its own desk-status line. Group accents
use the support module's muted sage, plum, and slate avatar tones on group
labels, section icons, and the status dot. Gold remains the active-item accent.
The colors are accents, not a second theme.

### 4. Customer support gets a Settings tab

The support app adds `/support/settings` and a Settings tab after Channels. It
uses the same `SettingsWorkspace` anatomy in embedded mode, inside the support
app's own horizontal tabs. Its sections are:

- Overview: loaded queue counts and the short path to configuration.
- Channels: the existing widget, greeting, auto-reply, and AI-boundary
  controls, rendered through the support Channels component in embedded mode.
- Notifications: the signed-in person's support ticket notification preference,
  using the existing notification-preferences API.
- Workspace: links to the shared organization, modules, AI, branding, team, and
  notification surfaces.
- Audit: the local conversation activity and the workspace audit ledger.

The default Overview is read-only. Channel changes still go through
`/api/support/channels` with its idempotency and approval behavior. The
notification preference remains a personal preference, not a queue rule. The
support Settings page invents no SLA, email, or agent fields that the support
schema does not store.

The Channels tab remains a channel-first route. Settings > Channels reuses the
same component and governed API, so there is one implementation and one policy,
not a second copy of channel configuration.

### 5. Shared dependencies stay explicit

Support Settings links to the surfaces that own shared facts instead of copying
them:

- organization facts, base currency, and print branding: `/settings/workspace`
- email delivery: `/settings/email`
- module switchboard: `/settings/modules`
- AI provider and models: `/settings/ai`
- agent persona and memory: `/settings/agent`
- people and roles: `/team`
- notifications: `/settings/notifications`
- evidence: `/ledger`

This keeps the support app independently useful without making it a second
identity, AI, or branding store.

## Consequences

- A new app can adopt the settings anatomy without adding another global tab
  strip or another left-nav implementation.
- CBOS Settings sections are shareable links, and the active section survives a
  reload.
- The support app now has a durable configuration surface and a place for
  personal support notifications.
- The Channels tab and Settings > Channels both expose the same channel
  controls. They share one component and one API; a future consolidation can
  remove the channel-first tab if the distinction stops earning its place.
- The mobile index is horizontal and scrolls the active section into view. It
  hides descriptions to preserve the configuration space.
- Exposing Email and Agent adds two sections, but removing the three access
  links and moving Quality and Branding into local views leaves a shorter index
  than the first pass.
- No new capability, table, or migration is introduced. The only new write path
  is the existing personal notification preference API.

## Verification

- `SettingsPage.test.tsx` covers the section links, existing settings behavior,
  and a direct `/settings/modules` deep link.
- `SupportApp.test.tsx` covers the Settings tab, the embedded channel controls,
  and saving the support ticket notification preference.
- Browser checks at 1440, 1024, and 390 widths confirm the left index, the
  compact mobile index, the visible active tab, and no horizontal overflow.
- The full TypeScript, Vite, Go, and production build gates pass.
