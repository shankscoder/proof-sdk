import { randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { generateSlug } from './slug.js';
import {
  addEvent,
  createDocument,
  createDocumentAccessToken,
  createLocalDashboardFolder,
  deleteDocument,
  deleteLocalDashboardFolder,
  getLocalDashboardFolder,
  getLocalDashboardFolderBreadcrumbs,
  listLocalDashboardFolderOptions,
  listLocalDashboardFolders,
  listLocalDashboardDocuments,
  listTrashDashboardDocuments,
  moveDocumentToLocalDashboardFolder,
  moveLocalDashboardFolder,
  renameLocalDashboardFolder,
  resumeDocument,
  revokeDocumentAccessTokens,
  type DashboardDocumentRow,
  type DashboardParticipantRow,
  type LocalDashboardFolderRow,
} from './db.js';
import { refreshSnapshotForSlug } from './snapshot.js';
import { canonicalizeStoredMarks } from '../src/formats/marks.js';
import { invalidateCollabDocument } from './collab.js';
import { closeRoom } from './ws.js';

export const dashboardRoutes = Router();

const DEFAULT_NEW_DOCUMENT_TITLE = 'Untitled';
const DEFAULT_NEW_DOCUMENT_MARKDOWN = '# Untitled\n\n';

type DashboardView = {
  currentFolder: LocalDashboardFolderRow | null;
  breadcrumbs: LocalDashboardFolderRow[];
  folders: LocalDashboardFolderRow[];
  folderOptions: LocalDashboardFolderRow[];
  documents: DashboardDocumentRow[];
  trashCount: number;
  isTrash?: boolean;
  notice?: string;
  error?: string;
};

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

function getBodyString(req: Request, key: string): string {
  const value = (req.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function safeReturnPath(req: Request, fallback: string = '/'): string {
  const explicit = getBodyString(req, 'returnTo');
  const candidate = explicit || req.get('referer') || fallback;
  try {
    const url = new URL(candidate, 'http://local.proof');
    if (url.origin !== 'http://local.proof') return fallback;
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}

function appendQueryMessage(path: string, key: 'notice' | 'error', message: string): string {
  const url = new URL(path, 'http://local.proof');
  url.searchParams.set(key, message);
  return `${url.pathname}${url.search}`;
}

function folderHref(folderId: string | null | undefined): string {
  return folderId ? `/folders/${encodeURIComponent(folderId)}` : '/';
}

function participantInitial(participant: DashboardParticipantRow): string {
  const trimmed = participant.name.trim();
  return (trimmed ? trimmed.charAt(0) : '?').toUpperCase();
}

function renderParticipants(participants: DashboardParticipantRow[] | undefined): string {
  const rows = participants ?? [];
  if (rows.length === 0) return '<span class="participants-empty">No participants yet</span>';
  const visible = rows.slice(0, 3);
  const overflow = rows.length - visible.length;
  const chips = visible.map((participant) => {
    const kindClass = participant.kind === 'agent' ? 'participant-agent' : 'participant-human';
    const label = `${participant.name}${participant.status ? ` (${participant.status})` : ''}`;
    return `<span class="participant-chip ${kindClass}" title="${escapeHtml(label)}">
      <span class="participant-avatar">${escapeHtml(participantInitial(participant))}</span>
      <span class="participant-name">${escapeHtml(participant.name)}</span>
    </span>`;
  }).join('');
  return `${chips}${overflow > 0 ? `<span class="participant-overflow">+${overflow}</span>` : ''}`;
}

function buildFolderDepths(folders: LocalDashboardFolderRow[]): Map<string, number> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const depths = new Map<string, number>();
  const resolveDepth = (folder: LocalDashboardFolderRow): number => {
    if (depths.has(folder.id)) return depths.get(folder.id) ?? 0;
    if (!folder.parent_id) {
      depths.set(folder.id, 0);
      return 0;
    }
    const parent = byId.get(folder.parent_id);
    const depth = parent ? resolveDepth(parent) + 1 : 0;
    depths.set(folder.id, depth);
    return depth;
  };
  for (const folder of folders) resolveDepth(folder);
  return depths;
}

function renderFolderSelect(
  folders: LocalDashboardFolderRow[],
  selectedFolderId: string | null | undefined,
  currentFolderIdToExclude?: string | null,
): string {
  const excluded = currentFolderIdToExclude ?? null;
  const depths = buildFolderDepths(folders);
  const options = folders
    .filter((folder) => folder.id !== excluded)
    .map((folder) => {
      const prefix = Array.from({ length: depths.get(folder.id) ?? 0 }).map(() => '--').join('');
      const label = `${prefix}${prefix ? ' ' : ''}${folder.name}`;
      const selected = selectedFolderId === folder.id ? ' selected' : '';
      return `<option value="${escapeHtml(folder.id)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join('');
  const rootSelected = selectedFolderId ? '' : ' selected';
  return `<select name="folderId">
    <option value=""${rootSelected}>Dashboard root</option>
    ${options}
  </select>`;
}

function renderBreadcrumbs(breadcrumbs: LocalDashboardFolderRow[], isTrash: boolean | undefined): string {
  if (isTrash) {
    return '<nav class="breadcrumbs"><a href="/">Documents</a><span>/</span><span>Trash</span></nav>';
  }
  const links = ['<a href="/">Documents</a>'];
  for (const folder of breadcrumbs) {
    links.push('<span>/</span>');
    links.push(`<a href="${folderHref(folder.id)}">${escapeHtml(folder.name)}</a>`);
  }
  return `<nav class="breadcrumbs">${links.join('')}</nav>`;
}

function renderFolderRow(folder: LocalDashboardFolderRow, folderOptions: LocalDashboardFolderRow[], returnTo: string): string {
  return `<article class="folder-row">
    <a class="folder-link" href="${folderHref(folder.id)}">
      <span class="folder-icon" aria-hidden="true">Folder</span>
      <span class="folder-name">${escapeHtml(folder.name)}</span>
    </a>
    <form class="compact-form" method="post" action="/dashboard/folders/${encodeURIComponent(folder.id)}/rename">
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
      <input name="name" value="${escapeHtml(folder.name)}" aria-label="Rename ${escapeHtml(folder.name)}" />
      <button type="submit">Rename</button>
    </form>
    <form class="compact-form" method="post" action="/dashboard/folders/${encodeURIComponent(folder.id)}/move">
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
      ${renderFolderSelect(folderOptions, folder.parent_id, folder.id)}
      <button type="submit">Move</button>
    </form>
    <form class="compact-form" method="post" action="/dashboard/folders/${encodeURIComponent(folder.id)}/delete">
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
      <button class="danger-button" type="submit">Delete</button>
    </form>
  </article>`;
}

function renderDocumentRow(doc: DashboardDocumentRow, folderOptions: LocalDashboardFolderRow[], returnTo: string, isTrash: boolean): string {
  const title = doc.title?.trim() || 'Untitled';
  const href = `/d/${encodeURIComponent(doc.slug)}`;
  const stateClass = `state-${doc.share_state.toLowerCase()}`;
  const controls = isTrash
    ? `<form method="post" action="/dashboard/documents/${encodeURIComponent(doc.slug)}/restore">
        <input type="hidden" name="returnTo" value="/trash" />
        <button type="submit">Restore</button>
      </form>`
    : `<form class="compact-form" method="post" action="/dashboard/documents/${encodeURIComponent(doc.slug)}/move">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
        ${renderFolderSelect(folderOptions, doc.folder_id ?? null)}
        <button type="submit">Move</button>
      </form>
      <form method="post" action="/dashboard/documents/${encodeURIComponent(doc.slug)}/trash">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
        <button class="danger-button" type="submit">Delete</button>
      </form>`;
  return `<article class="document-row">
    <a class="document-main" href="${href}">
      <span class="document-title">${escapeHtml(title)}</span>
      <span class="document-preview">${escapeHtml(summarizePreview(doc.preview))}</span>
      <span class="document-participants">${renderParticipants(doc.participants)}</span>
    </a>
    <span class="document-meta">
      ${isTrash && doc.folder_name ? `<span class="folder-tag">${escapeHtml(doc.folder_name)}</span>` : ''}
      <span class="document-updated">${escapeHtml(formatDate(doc.updated_at))}</span>
      <span class="document-state ${escapeHtml(stateClass)}">${escapeHtml(doc.share_state.toLowerCase())}</span>
    </span>
    <span class="row-actions">${controls}</span>
  </article>`;
}

function renderDashboardContent(view: DashboardView, returnTo: string): string {
  const folderRows = view.isTrash
    ? ''
    : view.folders.map((folder) => renderFolderRow(folder, view.folderOptions, returnTo)).join('\n');
  const documentRows = view.documents.map((doc) => renderDocumentRow(doc, view.folderOptions, returnTo, view.isTrash === true)).join('\n');
  const empty = view.isTrash
    ? '<section class="empty-state"><h2>Trash is empty</h2><p>Deleted documents will appear here until restored.</p></section>'
    : '<section class="empty-state"><h2>No documents here</h2><p>Create a document or move one into this folder.</p></section>';
  const content = `${folderRows}${folderRows && documentRows ? '\n' : ''}${documentRows}`;
  return content || empty;
}

export function renderDashboardHtml(view: DashboardView): string {
  const currentFolderId = view.currentFolder?.id ?? null;
  const currentPath = view.isTrash ? '/trash' : folderHref(currentFolderId);
  const title = view.isTrash ? 'Trash' : (view.currentFolder?.name ?? 'Documents');
  const subtitle = view.isTrash
    ? `${view.documents.length} deleted locally`
    : `${view.documents.length} document${view.documents.length === 1 ? '' : 's'} in this folder`;
  const notice = view.notice ? `<p class="notice">${escapeHtml(view.notice)}</p>` : '';
  const error = view.error ? `<p class="notice error">${escapeHtml(view.error)}</p>` : '';

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
        --danger: #b42318;
        --good: #21b878;
        --agent: #5b4bdb;
        --human: #197b6c;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
        color: var(--text);
        font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      button,
      input,
      select {
        font: inherit;
      }
      .shell {
        width: min(1120px, calc(100% - 40px));
        margin: 0 auto;
        padding: 32px 0 56px;
      }
      .topbar,
      .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }
      .topbar {
        margin-bottom: 18px;
      }
      .toolbar {
        margin-bottom: 18px;
        align-items: flex-end;
      }
      .brand {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      h1 {
        margin: 0;
        font-size: 28px;
        line-height: 1.1;
        letter-spacing: 0;
      }
      .subtitle,
      .breadcrumbs,
      .participants-empty {
        color: var(--muted);
      }
      .subtitle,
      .notice {
        margin: 0;
      }
      .breadcrumbs {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
        font-size: 14px;
      }
      a {
        color: inherit;
      }
      .breadcrumbs a {
        color: var(--muted);
        text-decoration: none;
      }
      .breadcrumbs a:hover {
        color: var(--text);
      }
      .new-button,
      .secondary-link,
      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 36px;
        padding: 0 14px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        color: var(--text);
        text-decoration: none;
        font-weight: 650;
        white-space: nowrap;
        cursor: pointer;
      }
      .new-button {
        min-height: 40px;
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
      }
      .danger-button {
        color: var(--danger);
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .new-folder {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      input,
      select {
        min-height: 36px;
        max-width: 220px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0 10px;
        background: #fff;
        color: var(--text);
      }
      .notice {
        margin-bottom: 12px;
        color: #335c46;
      }
      .notice.error {
        color: var(--danger);
      }
      .list {
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
      }
      .folder-row,
      .document-row {
        display: grid;
        grid-template-columns: minmax(220px, 1fr) auto auto;
        gap: 16px;
        align-items: center;
        min-height: 76px;
        padding: 14px 18px;
        border-top: 1px solid var(--line);
      }
      .folder-row:first-child,
      .document-row:first-child {
        border-top: 0;
      }
      .folder-row:hover,
      .document-row:hover {
        background: #fbfcf9;
      }
      .folder-link,
      .document-main {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
        color: inherit;
        text-decoration: none;
      }
      .folder-link {
        flex-direction: row;
        align-items: center;
        gap: 10px;
        font-weight: 650;
      }
      .folder-icon {
        color: var(--muted);
        font-size: 13px;
      }
      .document-title,
      .folder-name {
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
      .document-meta,
      .row-actions,
      .compact-form,
      .document-participants {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .document-meta {
        color: var(--muted);
        font-size: 13px;
      }
      .row-actions {
        justify-content: flex-end;
        flex-wrap: wrap;
      }
      .document-state,
      .folder-tag,
      .participant-overflow {
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
      .state-deleted {
        border-color: rgba(180, 35, 24, 0.24);
        color: var(--danger);
        background: rgba(180, 35, 24, 0.07);
      }
      .participant-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        color: var(--muted);
        font-size: 13px;
      }
      .participant-avatar {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: 999px;
        color: #fff;
        font-size: 11px;
        font-weight: 700;
      }
      .participant-human .participant-avatar {
        background: var(--human);
      }
      .participant-agent .participant-avatar {
        background: var(--agent);
      }
      .participant-name {
        max-width: 120px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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
        margin: 0;
        color: var(--muted);
      }
      @media (max-width: 880px) {
        .toolbar,
        .topbar {
          align-items: flex-start;
          flex-direction: column;
        }
        .folder-row,
        .document-row {
          grid-template-columns: 1fr;
          gap: 10px;
        }
        .document-meta,
        .row-actions {
          justify-content: flex-start;
        }
      }
      @media (max-width: 640px) {
        .shell {
          width: min(100% - 24px, 1120px);
          padding-top: 18px;
        }
        h1 {
          font-size: 24px;
        }
        .new-folder,
        .compact-form,
        .row-actions {
          align-items: stretch;
          flex-direction: column;
          width: 100%;
        }
        input,
        select,
        button {
          max-width: none;
          width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      ${renderBreadcrumbs(view.breadcrumbs, view.isTrash)}
      <header class="topbar">
        <div class="brand">
          <h1>${escapeHtml(title)}</h1>
          <p class="subtitle">${escapeHtml(subtitle)}</p>
        </div>
        <div class="actions">
          <a class="secondary-link" href="/trash">Trash${view.trashCount > 0 ? ` (${view.trashCount})` : ''}</a>
          <a class="new-button" href="/new">New +</a>
        </div>
      </header>
      ${view.isTrash ? '' : `<section class="toolbar" aria-label="Folder actions">
        <form class="new-folder" method="post" action="/dashboard/folders">
          <input type="hidden" name="parentId" value="${escapeHtml(currentFolderId ?? '')}" />
          <input type="hidden" name="returnTo" value="${escapeHtml(currentPath)}" />
          <input name="name" placeholder="Folder name" aria-label="Folder name" />
          <button type="submit">New folder</button>
        </form>
      </section>`}
      ${notice}
      ${error}
      <section class="list" aria-label="${view.isTrash ? 'Deleted documents' : 'Folder contents'}">
        ${renderDashboardContent(view, currentPath)}
      </section>
    </main>
  </body>
</html>`;
}

function getDashboardView(folderId: string | null, query: Request['query'] = {}): DashboardView {
  const currentFolder = folderId ? (getLocalDashboardFolder(folderId) ?? null) : null;
  const currentFolderId = currentFolder?.id ?? null;
  return {
    currentFolder,
    breadcrumbs: getLocalDashboardFolderBreadcrumbs(currentFolderId),
    folders: listLocalDashboardFolders(currentFolderId),
    folderOptions: listLocalDashboardFolderOptions(),
    documents: listLocalDashboardDocuments({ folderId: currentFolderId, limit: 200 }),
    trashCount: listTrashDashboardDocuments(500).length,
    notice: typeof query.notice === 'string' ? query.notice : undefined,
    error: typeof query.error === 'string' ? query.error : undefined,
  };
}

function renderFolderView(req: Request, folderId: string | null, res: Response): void {
  const view = getDashboardView(folderId, req.query);
  if (folderId && !view.currentFolder) {
    res.status(404).type('html').send(renderDashboardHtml({
      currentFolder: null,
      breadcrumbs: [],
      folders: [],
      folderOptions: listLocalDashboardFolderOptions(),
      documents: [],
      trashCount: listTrashDashboardDocuments(500).length,
      error: 'Folder not found',
    }));
    return;
  }
  res.type('html').send(renderDashboardHtml(view));
}

function redirectBack(req: Request, res: Response, fallback: string = '/'): void {
  res.redirect(303, safeReturnPath(req, fallback));
}

function redirectBackWithError(req: Request, res: Response, message: string, fallback: string = '/'): void {
  res.redirect(303, appendQueryMessage(safeReturnPath(req, fallback), 'error', message));
}

dashboardRoutes.get('/', (req, res) => {
  renderFolderView(req, null, res);
});

dashboardRoutes.get('/folders/:folderId', (req, res) => {
  renderFolderView(req, req.params.folderId, res);
});

dashboardRoutes.get('/trash', (req, res) => {
  res.type('html').send(renderDashboardHtml({
    currentFolder: null,
    breadcrumbs: [],
    folders: [],
    folderOptions: listLocalDashboardFolderOptions(),
    documents: listTrashDashboardDocuments(200),
    trashCount: listTrashDashboardDocuments(500).length,
    isTrash: true,
    notice: typeof req.query.notice === 'string' ? req.query.notice : undefined,
    error: typeof req.query.error === 'string' ? req.query.error : undefined,
  }));
});

dashboardRoutes.post('/dashboard/folders', (req, res) => {
  try {
    createLocalDashboardFolder(getBodyString(req, 'name'), getBodyString(req, 'parentId'));
    redirectBack(req, res);
  } catch (error) {
    redirectBackWithError(req, res, error instanceof Error ? error.message : 'Folder could not be created');
  }
});

dashboardRoutes.post('/dashboard/folders/:folderId/rename', (req, res) => {
  try {
    renameLocalDashboardFolder(req.params.folderId, getBodyString(req, 'name'));
    redirectBack(req, res);
  } catch (error) {
    redirectBackWithError(req, res, error instanceof Error ? error.message : 'Folder could not be renamed');
  }
});

dashboardRoutes.post('/dashboard/folders/:folderId/move', (req, res) => {
  try {
    moveLocalDashboardFolder(req.params.folderId, getBodyString(req, 'folderId'));
    redirectBack(req, res);
  } catch (error) {
    redirectBackWithError(req, res, error instanceof Error ? error.message : 'Folder could not be moved');
  }
});

dashboardRoutes.post('/dashboard/folders/:folderId/delete', (req, res) => {
  try {
    deleteLocalDashboardFolder(req.params.folderId);
    redirectBack(req, res);
  } catch (error) {
    redirectBackWithError(req, res, error instanceof Error ? error.message : 'Folder could not be deleted');
  }
});

dashboardRoutes.post('/dashboard/documents/:slug/move', (req, res) => {
  try {
    moveDocumentToLocalDashboardFolder(req.params.slug, getBodyString(req, 'folderId'));
    redirectBack(req, res);
  } catch (error) {
    redirectBackWithError(req, res, error instanceof Error ? error.message : 'Document could not be moved');
  }
});

dashboardRoutes.post('/dashboard/documents/:slug/trash', (req, res) => {
  const slug = req.params.slug;
  try {
    deleteDocument(slug);
    revokeDocumentAccessTokens(slug, undefined, { bumpEpoch: false });
    invalidateCollabDocument(slug);
    closeRoom(slug);
    addEvent(slug, 'document.deleted', { source: 'dashboard' }, 'local-dashboard');
    redirectBack(req, res);
  } catch (error) {
    redirectBackWithError(req, res, error instanceof Error ? error.message : 'Document could not be deleted');
  }
});

dashboardRoutes.post('/dashboard/documents/:slug/restore', (req, res) => {
  const slug = req.params.slug;
  try {
    resumeDocument(slug);
    addEvent(slug, 'document.restored', { source: 'dashboard' }, 'local-dashboard');
    refreshSnapshotForSlug(slug);
    redirectBack(req, res, '/trash');
  } catch (error) {
    res.redirect(303, `/trash?error=${encodeURIComponent(error instanceof Error ? error.message : 'Document could not be restored')}`);
  }
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
