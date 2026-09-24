# Gates: documents and shared quick actions

OWNS: apps/web/src/**, modules/documents/src/**, packages/db/src/**, CHANGELOG.md

Scope: add reusable quick actions, polished document template previews and editor entry points, and folder organization across the relevant ERP surfaces.

- [x] G1: the document template catalog contains three usable templates for each requested business record type
  CHECK: node -e "const fs=require('node:fs'); const p='apps/web/src/lib/document-templates.ts'; const s=fs.readFileSync(p,'utf8'); const types=['quotation','receipt','sales_invoice','purchase_order','voucher','delivery_note','employment_contract','employment_agreement']; for (const t of types) { const n=(s.match(new RegExp('type: \\\"'+t+'\\\"','g'))||[]).length; if(n!==3) throw new Error(t+' has '+n+' templates'); } console.log('DOCUMENT_TEMPLATE_CATALOG_OK count='+types.length*3)"
  EXPECT: DOCUMENT_TEMPLATE_CATALOG_OK
  EVIDENCE: DOCUMENT_TEMPLATE_CATALOG_OK count=24

- [x] G2: shared quick actions and folder-aware document navigation are wired into relevant pages
  CHECK: node -e "const fs=require('node:fs'); const files=['apps/web/src/components/quick-actions.tsx','apps/web/src/components/document-template-gallery.tsx','apps/web/src/app/(app)/documents/page.tsx','apps/web/src/app/(app)/documents/_write/write-tab.tsx','apps/web/src/app/(app)/accounting/page.tsx','apps/web/src/app/(app)/purchasing/page.tsx','apps/web/src/app/(app)/hr/page.tsx']; for (const p of files) { if(!fs.existsSync(p)) throw new Error('missing '+p); } const q=fs.readFileSync(files[0],'utf8'); if(!q.includes('QuickActions')) throw new Error('quick action component missing'); const d=fs.readFileSync(files[2],'utf8'); const w=fs.readFileSync(files[3],'utf8'); if(!d.includes('FolderTree')||!w.includes('DocumentTemplateGallery')||!w.includes('FolderTree')) throw new Error('documents surface not wired'); console.log('DOCUMENTS_UX_WIRING_OK')"
  EXPECT: DOCUMENTS_UX_WIRING_OK
  EVIDENCE: DOCUMENTS_UX_WIRING_OK; db:migrate completed successfully; module quick-action deep links now resolve through shared useTabParam

- [x] G3: the combined workspace passes repository verification
  CHECK: pnpm typecheck && pnpm lint && pnpm exec turbo test --concurrency=1 && node -e "console.log('DOCUMENTS_REPOSITORY_VERIFICATION_PASSED')"
  EXPECT: DOCUMENTS_REPOSITORY_VERIFICATION_PASSED
  EVIDENCE: typecheck passed (26 tasks); lint passed with 0 errors and 213 warnings; serialized tests passed (24 tasks, documents 9 tests, web 321 tests); final marker DOCUMENTS_REPOSITORY_VERIFICATION_PASSED

- [x] G4: the visual interaction is keyboard-accessible and usable on the relevant desktop and mobile surfaces
  EVIDENCE: authenticated agent-browser desktop and mobile checks covered labeled actions, template search, folder navigation, editor controls, preview tabs, keyboard save behavior, and responsive wrapped action groups; browser console and Next MCP runtime checks were clean.

- [x] G5: templates are professional business paper with structure-keyed rendering
  CHECK: node scripts/verify-documents-templates.mjs
  EXPECT: DOCUMENT TEMPLATE CATALOG OK
  EVIDENCE: gate asserts 24 templates in 8 types, letterhead-first anatomy, ruled data tables with totals for money documents, signature-line closures for delivery and employment paper, >= 4 fill-in fields each, and presentable demo values for every placeholder
- [x] G6: the gallery, studio, and editor surfaces render the new paper system on desktop and mobile
  EVIDENCE: agent-browser desktop (1440px) and mobile (390px) checks on /documents covered category chip filtering with counts, thumbnail-top cards with name and spec chip, the preview dialog, studio Fields/Preview tabs under 60rem and side-by-side panes above it, and the editor paper rendering refined tables with the full anatomy; `node scripts/verify-documents-matrix.mjs` reports DOCUMENT MATRIX OK for all 24 templates (editor preview, print surface, and PDF verified per template); template seeding refreshed system rows without touching custom templates.
- [x] G7: using a template commits in the studio form with design-group styling
  EVIDENCE: agent-browser flow verified Use this template saves under the entered file name, keeps the studio open with a saved status and Download PDF (print surface receives the document type variant), closes with Done, refreshes the library list with the new file, and never navigates to the editor; committed documents opened from the library render the financial variant through the document type.
