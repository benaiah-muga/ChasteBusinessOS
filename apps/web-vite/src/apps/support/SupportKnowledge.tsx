import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  FileText,
  Globe2,
  Loader2,
  Lock,
  MessageSquareText,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../ui/dialog";
import { useToast } from "../../ui/toast";
import {
  fetchSupportLibrary,
  readPendingSupportCannedResponse,
  readPendingSupportKbArticle,
  submitSupportCannedResponse,
  submitSupportKbArticle,
  type SupportLibrary,
} from "../../api/support";
import { useSupportDesk } from "./SupportDeskContext";
import { SupportEmpty } from "./SupportBits";

type CannedForm = { shortcut: string; title: string; body: string };
type ArticleForm = {
  title: string;
  body: string;
  category: string;
  isPublic: boolean;
};

const EMPTY_CANNED: CannedForm = { shortcut: "", title: "", body: "" };
const EMPTY_ARTICLE: ArticleForm = {
  title: "",
  body: "",
  category: "",
  isPublic: false,
};

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The knowledge library is unavailable.";
}

export function SupportKnowledge() {
  const { actorId, organizationId } = useSupportDesk();
  const { toast } = useToast();
  const [library, setLibrary] = useState<SupportLibrary | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [cannedOpen, setCannedOpen] = useState(false);
  const [articleOpen, setArticleOpen] = useState(false);
  const [cannedForm, setCannedForm] = useState<CannedForm>(EMPTY_CANNED);
  const [articleForm, setArticleForm] = useState<ArticleForm>(EMPTY_ARTICLE);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"canned" | "article" | null>(null);

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setLoadError(null);
    try {
      setLibrary(await fetchSupportLibrary(organizationId));
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!actorId || !organizationId) return;
    try {
      const canned = readPendingSupportCannedResponse({
        actorId,
        organizationId,
      });
      if (canned) {
        setCannedForm({
          shortcut: canned.shortcut,
          title: canned.title,
          body: canned.body,
        });
        setCannedOpen(true);
        setNotice(
          "An unresolved quick-reply save was restored. Save these exact details to recover its result.",
        );
      }
      const article = readPendingSupportKbArticle({ actorId, organizationId });
      if (article) {
        setArticleForm({
          title: article.title,
          body: article.body,
          category: article.category ?? "",
          isPublic: article.isPublic,
        });
        setArticleOpen(true);
        setNotice(
          "An unresolved article save was restored. Save these exact details to recover its result.",
        );
      }
    } catch {
      // The forms remain usable without retry recovery.
    }
  }, [actorId, organizationId]);

  const normalizedQuery = query.trim().toLowerCase();
  const canned = useMemo(
    () =>
      (library?.canned ?? []).filter(
        (reply) =>
          !normalizedQuery ||
          `${reply.shortcut} ${reply.title} ${reply.body}`
            .toLowerCase()
            .includes(normalizedQuery),
      ),
    [library, normalizedQuery],
  );
  const articles = useMemo(
    () =>
      (library?.articles ?? []).filter(
        (article) =>
          !normalizedQuery ||
          `${article.title} ${article.category ?? ""} ${article.body}`
            .toLowerCase()
            .includes(normalizedQuery),
      ),
    [library, normalizedQuery],
  );

  async function saveCanned() {
    if (!actorId || !organizationId) return;
    const input = {
      shortcut: cannedForm.shortcut.trim(),
      title: cannedForm.title.trim(),
      body: cannedForm.body.trim(),
    };
    if (!input.shortcut || !input.title || !input.body) return;
    setSaving("canned");
    setDialogError(null);
    try {
      const outcome = await submitSupportCannedResponse(
        { action: "createCannedResponse", ...input },
        { actorId, organizationId },
      );
      if (outcome.kind === "pending") {
        setDialogError(outcome.reason);
        return;
      }
      setCannedOpen(false);
      setCannedForm(EMPTY_CANNED);
      toast({
        title: "Quick reply saved",
        description: "It is available in the conversation composer.",
        tone: "success",
      });
      await load();
    } catch (error) {
      setDialogError(errorMessage(error));
    } finally {
      setSaving(null);
    }
  }

  async function saveArticle() {
    if (!actorId || !organizationId) return;
    const input = {
      title: articleForm.title.trim(),
      body: articleForm.body.trim(),
      category: articleForm.category.trim() || undefined,
      isPublic: articleForm.isPublic,
    };
    if (!input.title || !input.body) return;
    setSaving("article");
    setDialogError(null);
    try {
      const outcome = await submitSupportKbArticle(
        { action: "createKbArticle", ...input },
        { actorId, organizationId },
      );
      if (outcome.kind === "pending") {
        setDialogError(outcome.reason);
        return;
      }
      setArticleOpen(false);
      setArticleForm(EMPTY_ARTICLE);
      toast({
        title: "Article saved",
        description: "The next copilot draft can draw from it.",
        tone: "success",
      });
      await load();
    } catch (error) {
      setDialogError(errorMessage(error));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="support-page">
      <header className="support-page-head">
        <div>
          <p className="support-eyebrow">Knowledge</p>
          <h1>What the desk knows</h1>
          <p>
            Quick replies keep answers consistent. Articles give the copilot
            reviewed facts to stand on. Neither speaks to a customer without a
            person.
          </p>
        </div>
        <div className="support-page-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setCannedOpen(true);
              setDialogError(null);
              setNotice(null);
            }}
          >
            <MessageSquareText size={13} aria-hidden="true" /> New quick reply
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setArticleOpen(true);
              setDialogError(null);
              setNotice(null);
            }}
          >
            <Plus size={13} aria-hidden="true" /> New article
          </Button>
        </div>
      </header>

      {notice && (
        <div className="support-inline-notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss notice"
          >
            ×
          </button>
        </div>
      )}

      <div className="support-knowledge-toolbar">
        <label className="support-search support-search-wide">
          <Search size={14} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search quick replies and articles..."
            aria-label="Search knowledge"
          />
        </label>
        <span className="support-knowledge-count">
          {canned.length}{" "}
          {canned.length === 1 ? "quick reply" : "quick replies"} ·{" "}
          {articles.length} {articles.length === 1 ? "article" : "articles"}
        </span>
      </div>

      {loading && !library && (
        <p className="support-panel-note" role="status">
          <Loader2 size={13} className="support-spin" aria-hidden="true" />{" "}
          Loading the knowledge library...
        </p>
      )}
      {loadError && (
        <div className="support-panel-error" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      <div className="support-knowledge-grid">
        <section
          className="support-overview-panel"
          aria-labelledby="support-quick-replies"
        >
          <header className="support-overview-panel-head">
            <div>
              <h2 id="support-quick-replies">Quick replies</h2>
              <p>
                Reusable staff replies with a shortcut. Insert one in the
                composer, then edit before sending.
              </p>
            </div>
            <MessageSquareText size={16} aria-hidden="true" />
          </header>
          {!loading && canned.length === 0 && (
            <SupportEmpty
              icon={MessageSquareText}
              title={
                normalizedQuery
                  ? "No quick replies match."
                  : "No quick replies yet."
              }
              detail={
                normalizedQuery
                  ? "Try a different search."
                  : "Save the answers your team repeats, with a shortcut for the composer."
              }
              compact
              action={
                !normalizedQuery ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setCannedOpen(true)}
                  >
                    New quick reply
                  </Button>
                ) : undefined
              }
            />
          )}
          <div className="support-knowledge-list">
            {canned.map((reply) => (
              <article className="support-knowledge-card" key={reply.id}>
                <header>
                  <span className="support-shortcut">{reply.shortcut}</span>
                  <strong>{reply.title}</strong>
                </header>
                <p>{reply.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section
          className="support-overview-panel"
          aria-labelledby="support-articles"
        >
          <header className="support-overview-panel-head">
            <div>
              <h2 id="support-articles">Articles</h2>
              <p>
                Reviewed facts the copilot can retrieve. Public articles can
                also answer the website widget.
              </p>
            </div>
            <BookOpen size={16} aria-hidden="true" />
          </header>
          {!loading && articles.length === 0 && (
            <SupportEmpty
              icon={BookOpen}
              title={
                normalizedQuery ? "No articles match." : "No articles yet."
              }
              detail={
                normalizedQuery
                  ? "Try a different search."
                  : "Write down the policies and answers your team should never have to improvise."
              }
              compact
              action={
                !normalizedQuery ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setArticleOpen(true)}
                  >
                    New article
                  </Button>
                ) : undefined
              }
            />
          )}
          <div className="support-knowledge-list">
            {articles.map((article) => (
              <article
                className="support-knowledge-card support-article-card"
                key={article.id}
              >
                <header>
                  <FileText size={13} aria-hidden="true" />
                  <strong>{article.title}</strong>
                  {article.category && (
                    <span className="support-article-category">
                      {article.category}
                    </span>
                  )}
                  <span
                    className="support-article-visibility"
                    title={
                      article.isPublic
                        ? "Public to the website widget"
                        : "Internal to the desk"
                    }
                  >
                    {article.isPublic ? (
                      <Globe2 size={11} aria-hidden="true" />
                    ) : (
                      <Lock size={11} aria-hidden="true" />
                    )}
                    {article.isPublic ? "Public" : "Internal"}
                  </span>
                </header>
                <p>{article.body}</p>
              </article>
            ))}
          </div>
        </section>

        <aside
          className="support-overview-panel support-grounding-panel"
          aria-labelledby="support-grounding"
        >
          <header className="support-overview-panel-head">
            <div>
              <h2 id="support-grounding">How grounding works</h2>
              <p>No invented facts, no silent sends.</p>
            </div>
            <Sparkles size={16} aria-hidden="true" />
          </header>
          <ul>
            <li>
              <span>1</span>
              <p>
                The copilot reads this library and the selected customer's own
                record.
              </p>
            </li>
            <li>
              <span>2</span>
              <p>
                It drafts into the composer. A person reviews, edits, or
                discards it.
              </p>
            </li>
            <li>
              <span>3</span>
              <p>
                The released reply is a staff message on the thread and in the
                audit ledger.
              </p>
            </li>
          </ul>
          <p className="support-grounding-note">
            The support module never posts to a customer on its own.
            Auto-replies to the website widget are a separate, explicit channel
            setting.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setArticleOpen(true)}
          >
            Add a reviewed fact
          </Button>
        </aside>
      </div>

      <Dialog open={cannedOpen} onOpenChange={setCannedOpen}>
        <DialogContent className="support-dialog">
          <DialogTitle>New quick reply</DialogTitle>
          <DialogDescription>
            Save a reusable staff reply. Shortcuts are how the composer finds
            it.
          </DialogDescription>
          {dialogError && (
            <p className="support-dialog-error" role="alert">
              {dialogError}
            </p>
          )}
          <label className="support-field">
            <span>Shortcut</span>
            <input
              value={cannedForm.shortcut}
              maxLength={40}
              onChange={(event) =>
                setCannedForm({ ...cannedForm, shortcut: event.target.value })
              }
              placeholder="/refund"
              autoFocus
            />
          </label>
          <label className="support-field">
            <span>Title</span>
            <input
              value={cannedForm.title}
              maxLength={120}
              onChange={(event) =>
                setCannedForm({ ...cannedForm, title: event.target.value })
              }
              placeholder="Refund policy"
            />
          </label>
          <label className="support-field">
            <span>Reply</span>
            <textarea
              value={cannedForm.body}
              maxLength={4000}
              rows={5}
              onChange={(event) =>
                setCannedForm({ ...cannedForm, body: event.target.value })
              }
              placeholder="The reply the team should start from..."
            />
          </label>
          <div className="support-dialog-actions">
            <Button
              variant="ghost"
              onClick={() => setCannedOpen(false)}
              disabled={saving !== null}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void saveCanned()}
              disabled={
                saving !== null ||
                !cannedForm.shortcut.trim() ||
                !cannedForm.title.trim() ||
                !cannedForm.body.trim()
              }
            >
              {saving === "canned" ? (
                <Loader2
                  size={13}
                  className="support-spin"
                  aria-hidden="true"
                />
              ) : (
                <Plus size={13} aria-hidden="true" />
              )}
              {saving === "canned" ? "Saving..." : "Save quick reply"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={articleOpen} onOpenChange={setArticleOpen}>
        <DialogContent className="support-dialog">
          <DialogTitle>New article</DialogTitle>
          <DialogDescription>
            Write one reviewed fact or policy. Keep it specific enough to cite.
          </DialogDescription>
          {dialogError && (
            <p className="support-dialog-error" role="alert">
              {dialogError}
            </p>
          )}
          <label className="support-field">
            <span>Title</span>
            <input
              value={articleForm.title}
              maxLength={200}
              onChange={(event) =>
                setArticleForm({ ...articleForm, title: event.target.value })
              }
              placeholder="Refund and proration policy"
              autoFocus
            />
          </label>
          <div className="support-field-row">
            <label className="support-field">
              <span>Category</span>
              <input
                value={articleForm.category}
                maxLength={40}
                onChange={(event) =>
                  setArticleForm({
                    ...articleForm,
                    category: event.target.value,
                  })
                }
                placeholder="billing"
              />
            </label>
            <label className="support-check-field">
              <input
                type="checkbox"
                checked={articleForm.isPublic}
                onChange={(event) =>
                  setArticleForm({
                    ...articleForm,
                    isPublic: event.target.checked,
                  })
                }
              />
              <span>Public to the website widget</span>
            </label>
          </div>
          <label className="support-field">
            <span>Article</span>
            <textarea
              value={articleForm.body}
              maxLength={20_000}
              rows={7}
              onChange={(event) =>
                setArticleForm({ ...articleForm, body: event.target.value })
              }
              placeholder="The policy, the steps, the edge cases..."
            />
          </label>
          <div className="support-dialog-actions">
            <Button
              variant="ghost"
              onClick={() => setArticleOpen(false)}
              disabled={saving !== null}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void saveArticle()}
              disabled={
                saving !== null ||
                !articleForm.title.trim() ||
                !articleForm.body.trim()
              }
            >
              {saving === "article" ? (
                <Loader2
                  size={13}
                  className="support-spin"
                  aria-hidden="true"
                />
              ) : (
                <Plus size={13} aria-hidden="true" />
              )}
              {saving === "article" ? "Saving..." : "Save article"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
