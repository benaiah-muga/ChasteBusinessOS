# Gates: auth and onboarding first impression

OWNS: apps/web/src/app/login/page.tsx, apps/web/src/components/onboarding/parts.tsx, apps/web/src/components/onboarding/wizard.tsx, apps/web/src/app/globals.css, apps/web/src/app/page.tsx, CHANGELOG.md, GATES.md

Scope: upgrade the auth and onboarding first-run experience with the Chaste black, ivory, and champagne-gold identity, visible progress motion, responsive no-scroll layouts, and graceful route behavior.

- [x] G1: auth and onboarding source contain the brand treatment, animated progress system, and reduced-motion safeguards
  CHECK: node -e "const fs=require('fs'); const files=['apps/web/src/app/login/page.tsx','apps/web/src/components/onboarding/parts.tsx','apps/web/src/components/onboarding/wizard.tsx','apps/web/src/app/globals.css']; const s=files.map(f=>fs.readFileSync(f,'utf8')).join('\\n'); for (const needle of ['linear-gradient','box-shadow','prefers-reduced-motion','progressbar','Chaste Business OS']) if (!s.includes(needle)) throw new Error('missing '+needle); console.log('visual source verification passed')"
  EXPECT: visual source verification passed
  EVIDENCE: visual source verification passed after final CSS/component changes.

- [ ] G2: the web app passes the required static verification gate
  CHECK: pnpm typecheck && pnpm lint && pnpm test
  EXPECT: /Tests?\s+\d+\s+passed|passed|PASS/
  CWD: .
  EVIDENCE: `pnpm typecheck` passed; `pnpm lint` passed with 178 pre-existing warnings; repo-wide `pnpm test` reached 280/281 with one timing-sensitive worker-kill miss, then the isolated test passed 3/3. Onboarding wizard suite passed 19/19.

- [x] G3: live auth and onboarding routes render without runtime errors and fit the viewport at desktop and mobile widths
  EVIDENCE: Next MCP reported no session errors; `/login` and `/onboarding` compiled with `issues:[]`; browser checks showed no scroll at 1280x720 and 390x844; unauthenticated `/onboarding` redirected to `/login`.

- [x] G4: the refreshed auth/onboarding experience is recorded in the unreleased changelog
  CHECK: node -e "const s=require('fs').readFileSync('CHANGELOG.md','utf8'); if (!/^## \\[Unreleased\\][\\s\\S]*auth|onboarding/im.test(s)) throw new Error('missing changelog entry'); console.log('changelog verification passed')"
  EXPECT: changelog verification passed
  EVIDENCE: changelog verification passed.
