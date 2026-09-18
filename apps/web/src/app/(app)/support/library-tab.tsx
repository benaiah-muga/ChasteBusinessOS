"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardTitle, EmptyState } from "@/components/ui";
import { IconLifeBuoy } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";

interface CannedRow {
  id: string;
  shortcut: string;
  title: string;
  body: string;
}
interface ArticleRow {
  id: string;
  title: string;
  body: string;
  category: string | null;
}

const emptyCanned = { shortcut: "", title: "", body: "" };
const emptyArticle = { title: "", body: "", category: "" };

/** Canned responses and knowledge-base articles — the support library. */
export function LibraryTab() {
  const [canned, setCanned] = useState<CannedRow[] | null>(null);
  const [articles, setArticles] = useState<ArticleRow[] | null>(null);
  const [cannedForm, setCannedForm] = useState(emptyCanned);
  const [articleForm, setArticleForm] = useState(emptyArticle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await callApi<{ canned?: CannedRow[]; articles?: ArticleRow[] }>("/api/support?library=1");
    if (!res.ok || !res.data) {
      setError(res.error?.title ?? "Couldn't load the library");
      return;
    }
    setCanned(res.data.canned ?? []);
    setArticles(res.data.articles ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveCanned(): Promise<void> {
    if (!cannedForm.shortcut.trim() || !cannedForm.title.trim() || !cannedForm.body.trim()) return;
    setBusy(true);
    const res = await postApi("/api/support", {
      action: "createCannedResponse",
      shortcut: cannedForm.shortcut.trim(),
      title: cannedForm.title.trim(),
      body: cannedForm.body.trim(),
    });
    setBusy(false);
    if (!res.ok && res.error) {
      setError(res.error.hint ?? res.error.title);
      return;
    }
    setCannedForm(emptyCanned);
    await load();
  }

  async function saveArticle(): Promise<void> {
    if (!articleForm.title.trim() || !articleForm.body.trim()) return;
    setBusy(true);
    const res = await postApi("/api/support", {
      action: "createKbArticle",
      title: articleForm.title.trim(),
      body: articleForm.body.trim(),
      category: articleForm.category.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok && res.error) {
      setError(res.error.hint ?? res.error.title);
      return;
    }
    setArticleForm(emptyArticle);
    await load();
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4">
      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}

      <Card>
        <CardTitle>Save a canned response</CardTitle>
        <form
          className="space-y-2 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void saveCanned();
          }}
        >
          <div className="flex flex-wrap gap-2">
            <div className="w-36">
              <label htmlFor="canned-shortcut" className="label">
                Shortcut
              </label>
              <input
                id="canned-shortcut"
                className="input"
                placeholder="/refund"
                value={cannedForm.shortcut}
                onChange={(e) => setCannedForm({ ...cannedForm, shortcut: e.target.value })}
              />
            </div>
            <div className="min-w-48 flex-1">
              <label htmlFor="canned-title" className="label">
                Title
              </label>
              <input
                id="canned-title"
                className="input"
                placeholder="Refund policy answer"
                value={cannedForm.title}
                onChange={(e) => setCannedForm({ ...cannedForm, title: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label htmlFor="canned-body" className="label">
              Reply body
            </label>
            <textarea
              id="canned-body"
              rows={3}
              className="textarea w-full"
              value={cannedForm.body}
              onChange={(e) => setCannedForm({ ...cannedForm, body: e.target.value })}
            />
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={busy} disabled={!cannedForm.shortcut.trim() || !cannedForm.title.trim() || !cannedForm.body.trim()}>
              Save response
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardTitle right={<span className="text-xs text-stone-500">{canned?.length ?? 0}</span>}>Canned responses</CardTitle>
        {canned === null ? (
          <p className="text-sm text-stone-400">Loading…</p>
        ) : canned.length === 0 ? (
          <EmptyState icon={<IconLifeBuoy className="size-5" />} title="No canned responses yet" hint="Save the replies you type twice or more." />
        ) : (
          <ul className="divide-y text-sm">
            {canned.map((c) => (
              <li key={c.id} className="py-2.5">
                <div className="flex items-center gap-2">
                  <Badge tone="gold">{c.shortcut}</Badge>
                  <span className="font-medium text-stone-800">{c.title}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-stone-500">{c.body}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardTitle>Author a knowledge-base article</CardTitle>
        <form
          className="space-y-2 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void saveArticle();
          }}
        >
          <div className="flex flex-wrap gap-2">
            <div className="min-w-48 flex-1">
              <label htmlFor="kb-title" className="label">
                Title
              </label>
              <input
                id="kb-title"
                className="input"
                placeholder="How returns work"
                value={articleForm.title}
                onChange={(e) => setArticleForm({ ...articleForm, title: e.target.value })}
              />
            </div>
            <div className="w-40">
              <label htmlFor="kb-category" className="label">
                Category <span className="opacity-50">(optional)</span>
              </label>
              <input
                id="kb-category"
                className="input"
                placeholder="shipping"
                value={articleForm.category}
                onChange={(e) => setArticleForm({ ...articleForm, category: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label htmlFor="kb-body" className="label">
              Body
            </label>
            <textarea
              id="kb-body"
              rows={5}
              className="textarea w-full"
              placeholder="Answer the question once, publicly, so it stops arriving twice a week."
              value={articleForm.body}
              onChange={(e) => setArticleForm({ ...articleForm, body: e.target.value })}
            />
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={busy} disabled={!articleForm.title.trim() || !articleForm.body.trim()}>
              Publish article
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardTitle right={<span className="text-xs text-stone-500">{articles?.length ?? 0}</span>}>Knowledge base</CardTitle>
        {articles === null ? (
          <p className="text-sm text-stone-400">Loading…</p>
        ) : articles.length === 0 ? (
          <EmptyState icon={<IconLifeBuoy className="size-5" />} title="No articles yet" hint="The website widget's AI answers are grounded in these." />
        ) : (
          <ul className="divide-y text-sm">
            {articles.map((a) => (
              <li key={a.id} className="py-2.5">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-stone-800">{a.title}</span>
                  {a.category && <Badge>{a.category}</Badge>}
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-stone-500">{a.body}</p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-stone-400">Articles are live immediately — the website widget&apos;s AI answers are grounded in these.</p>
      </Card>
    </div>
  );
}
