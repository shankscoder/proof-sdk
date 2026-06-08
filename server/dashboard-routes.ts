import { randomUUID } from 'crypto';
import { Router, type Request } from 'express';
import { generateSlug } from './slug.js';
import {
  addEvent,
  createDocument,
  createDocumentAccessToken,
  listLocalDashboardDocuments,
  type DashboardDocumentRow,
} from './db.js';
import { refreshSnapshotForSlug } from './snapshot.js';
import { canonicalizeStoredMarks } from '../src/formats/marks.js';

export const dashboardRoutes = Router();

const DEFAULT_NEW_DOCUMENT_TITLE = 'Untitled';
const DEFAULT_NEW_DOCUMENT_MARKDOWN = '# Untitled\n\n';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getPublicBaseUrl(req: Request): string {
  const configuredBase = (process.env.PROOF_PUBLIC_BASE_URL || '').trim();
  if (configuredBase) return configuredBase.replace(/\/+$/, '');
  const host = req.get('host') || '';
  if (!host) return '';
  return `${req.protocol || 'http'}://${host}`;
}

function withShareToken(url: string, token: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function summarizePreview(value: string | null | undefined): string {
  const normalized = (value ?? '')
    .replace(/[#*_`>\-[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return 'No preview yet';
  return normalized.length > 140 ? `${normalized.slice(0, 137).trimEnd()}...` : normalized;
}

function renderDocumentRow(doc: DashboardDocumentRow): string {
  const title = doc.title?.trim() || 'Untitled';
  const href = `/d/${encodeURIComponent(doc.slug)}`;
  const stateClass = `state-${doc.share_state.toLowerCase()}`;
  return `<a class="document-row" href="${href}">
    <span class="document-main">
      <span class="document-title">${escapeHtml(title)}</span>
      <span class="document-preview">${escapeHtml(summarizePreview(doc.preview))}</span>
    </span>
    <span class="document-meta">
      <span class="document-updated">${escapeHtml(formatDate(doc.updated_at))}</span>
      <span class="document-state ${escapeHtml(stateClass)}">${escapeHtml(doc.share_state.toLowerCase())}</span>
    </span>
  </a>`;
}

export function renderDashboardHtml(documents: DashboardDocumentRow[]): string {
  const rows = documents.map(renderDocumentRow).join('\n');
  const content = rows || `<section class="empty-state">
    <h2>No documents yet</h2>
    <p>Create a document to start writing with a persistent local URL.</p>
    <a class="empty-action" href="/new">New +</a>
  </section>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Proof SDK</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f8f5;
        --surface: #ffffff;
        --text: #161a17;
        --muted: #667068;
        --line: #e1e5dd;
        --accent: #111111;
        --good: #21b878;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
        color: var(--text);
        font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      .shell {
        width: min(1040px, calc(100% - 40px));
        margin: 0 auto;
        padding: 32px 0 56px;
      }
      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 24px;
      }
      .brand {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      h1 {
        margin: 0;
        font-size: 28px;
        line-height: 1.1;
        letter-spacing: 0;
      }
      .subtitle {
        margin: 0;
        color: var(--muted);
      }
      .new-button,
      .empty-action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 40px;
        padding: 0 16px;
        border-radius: 8px;
        background: var(--accent);
        color: #fff;
        text-decoration: none;
        font-weight: 650;
        white-space: nowrap;
      }
      .document-list {
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
      }
      .document-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 20px;
        align-items: center;
        min-height: 76px;
        padding: 14px 18px;
        color: inherit;
        text-decoration: none;
        border-top: 1px solid var(--line);
      }
      .document-row:first-child { border-top: 0; }
      .document-row:hover { background: #fbfcf9; }
      .document-main {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .document-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: 650;
      }
      .document-preview {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--muted);
      }
      .document-meta {
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--muted);
        font-size: 13px;
      }
      .document-state {
        padding: 3px 8px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: #fafbf8;
        color: var(--muted);
      }
      .state-active {
        border-color: rgba(33, 184, 120, 0.25);
        color: #177b52;
        background: rgba(33, 184, 120, 0.08);
      }
      .empty-state {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        padding: 32px;
      }
      .empty-state h2 {
        margin: 0 0 6px;
        font-size: 20px;
        letter-spacing: 0;
      }
      .empty-state p {
        margin: 0 0 18px;
        color: var(--muted);
      }
      @media (max-width: 640px) {
        .shell {
          width: min(100% - 24px, 1040px);
          padding-top: 18px;
        }
        .topbar {
          align-items: flex-start;
        }
        h1 {
          font-size: 24px;
        }
        .document-row {
          grid-template-columns: 1fr;
          gap: 8px;
        }
        .document-meta {
          justify-content: space-between;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header class="topbar">
        <div class="brand">
          <h1>Documents</h1>
          <p class="subtitle">${documents.length} saved locally</p>
        </div>
        <a class="new-button" href="/new">New +</a>
      </header>
      <section class="document-list" aria-label="Saved documents">
        ${content}
      </section>
    </main>
  </body>
</html>`;
}

dashboardRoutes.get('/', (_req, res) => {
  const documents = listLocalDashboardDocuments(200);
  res.type('html').send(renderDashboardHtml(documents));
});

dashboardRoutes.get('/new', (req, res) => {
  const slug = generateSlug();
  const ownerSecret = randomUUID();
  const marks = canonicalizeStoredMarks({});
  const doc = createDocument(
    slug,
    DEFAULT_NEW_DOCUMENT_MARKDOWN,
    marks,
    DEFAULT_NEW_DOCUMENT_TITLE,
    'local-dashboard',
    ownerSecret,
  );
  const access = createDocumentAccessToken(doc.slug, 'editor');
  refreshSnapshotForSlug(doc.slug);
  addEvent(doc.slug, 'document.created', {
    title: DEFAULT_NEW_DOCUMENT_TITLE,
    ownerId: 'local-dashboard',
    shareState: doc.share_state,
    source: 'dashboard.new',
    accessRole: access.role,
  }, 'local-dashboard');

  const base = getPublicBaseUrl(req);
  const cleanUrl = `/d/${encodeURIComponent(doc.slug)}`;
  const redirectUrl = withShareToken(base ? `${base}${cleanUrl}` : cleanUrl, access.secret);
  res.redirect(302, redirectUrl);
});
