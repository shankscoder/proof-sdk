import { Fragment, Schema, Slice } from '@milkdown/kit/prose/model';
import { EditorState, Plugin, TextSelection } from '@milkdown/kit/prose/state';

import { applyRemoteMarks, getMarkMetadataWithQuotes, marksPluginKey } from '../editor/plugins/marks.js';
import { wrapTransactionForSuggestions } from '../editor/plugins/suggestions.js';
import type { StoredMark } from '../formats/marks.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
  },
  marks: {
    proofSuggestion: {
      attrs: {
        id: { default: null },
        kind: { default: 'replace' },
        by: { default: 'unknown' },
        content: { default: null },
        status: { default: 'pending' },
        createdAt: { default: null },
      },
      inclusive: false,
      spanning: true,
    },
  },
});

const marksStatePlugin = new Plugin({
  key: marksPluginKey,
  state: {
    init: () => ({ metadata: {}, activeMarkId: null, composeAnchorRange: null }),
    apply: (tr, value) => {
      const meta = tr.getMeta(marksPluginKey);
      if (meta?.type === 'SET_METADATA') {
        return { ...value, metadata: meta.metadata };
      }
      return value;
    },
  },
});

function createState(text: string): EditorState {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, text ? [schema.text(text)] : undefined),
  ]);
  const cursor = 1 + text.length;
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, cursor),
    plugins: [marksStatePlugin],
  });
}

function insertTextWithSuggestions(state: EditorState, text: string): EditorState {
  const tr = state.tr.insertText(text, state.selection.from, state.selection.to);
  return state.apply(wrapTransactionForSuggestions(tr, state, true));
}

function pastePlainTextBlockWithSuggestions(state: EditorState, text: string): EditorState {
  const paragraph = schema.node('paragraph', null, [schema.text(text)]);
  const slice = new Slice(Fragment.from(paragraph), 1, 1);
  const tr = state.tr.replaceSelection(slice);
  return state.apply(wrapTransactionForSuggestions(tr, state, true));
}

function collectSuggestionRuns(state: EditorState): Array<{ text: string; ids: Set<string> }> {
  const runs: Array<{ text: string; ids: Set<string> }> = [];
  state.doc.descendants((node) => {
    if (!node.isText) return true;
    const ids = new Set(
      node.marks
        .filter((mark) => mark.type.name === 'proofSuggestion' && mark.attrs.kind === 'insert')
        .map((mark) => String(mark.attrs.id)),
    );
    if (ids.size > 0) {
      runs.push({ text: node.text ?? '', ids });
    }
    return true;
  });
  return runs;
}

function run(): void {
  let state = createState('Hello');

  for (const text of ['a', 'b', ' ', 'c', '1']) {
    state = insertTextWithSuggestions(state, text);
  }

  assert(state.doc.textContent === 'Helloab c1', `Expected sequential typing to insert text, got ${state.doc.textContent}`);
  assert(state.selection.from === 11, `Expected cursor after typed text, got ${state.selection.from}`);

  const typedRuns = collectSuggestionRuns(state);
  assert(typedRuns.length === 1, `Expected typed characters to coalesce into one suggestion run, got ${typedRuns.length}`);
  assert(typedRuns[0].text === 'ab c1', `Expected typed suggestion text "ab c1", got ${typedRuns[0].text}`);
  assert(typedRuns[0].ids.size === 1, `Expected typed suggestion to share one mark id, got ${typedRuns[0].ids.size}`);
  const typedId = [...typedRuns[0].ids][0] ?? '';
  assert(typedId.length > 0, 'Expected typed suggestion id to be present');
  const typedMetadata = getMarkMetadataWithQuotes(state)[typedId];
  assert(typedMetadata !== undefined, 'Expected typed suggestion metadata to be present');
  assert(typedMetadata.quote === 'ab c1', `Expected typed suggestion metadata quote "ab c1", got ${String(typedMetadata.quote)}`);
  assert(typedMetadata.range?.from === 6 && typedMetadata.range?.to === 11, `Expected typed suggestion range 6-11, got ${JSON.stringify(typedMetadata.range)}`);

  state = pastePlainTextBlockWithSuggestions(state, ' pasted');
  assert(state.doc.textContent === 'Helloab c1 pasted', `Expected paste-like insert to preserve text, got ${state.doc.textContent}`);
  assert(state.selection.from === 18, `Expected cursor after paste-like insert, got ${state.selection.from}`);

  const pastedRuns = collectSuggestionRuns(state);
  assert(pastedRuns.length === 1, `Expected paste-like insert to remain in the same suggestion run, got ${pastedRuns.length}`);
  assert(pastedRuns[0].text === 'ab c1 pasted', `Expected pasted suggestion text to be tracked, got ${pastedRuns[0].text}`);
  const pastedMetadata = getMarkMetadataWithQuotes(state)[typedId];
  assert(pastedMetadata !== undefined, 'Expected pasted suggestion metadata to be present');
  assert(pastedMetadata.quote === 'ab c1 pasted', `Expected pasted suggestion metadata quote "ab c1 pasted", got ${String(pastedMetadata.quote)}`);
  assert(pastedMetadata.range?.from === 6 && pastedMetadata.range?.to === 18, `Expected pasted suggestion range 6-18, got ${JSON.stringify(pastedMetadata.range)}`);

  console.log('✓ suggestions typing preserves cursor and tracks printable text');

  state = createState('Clean document text');
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: any) {
      state = state.apply(tr);
    },
  } as any;
  const staleMetadata: Record<string, StoredMark> = {
    'm-stale-local': {
      kind: 'insert',
      by: 'human:Shanks',
      createdAt: '2026-06-08T00:00:00.000Z',
      content: 'stale suggestion',
      status: 'pending',
      quote: 'text that no longer exists',
    },
    'authored:human:Shanks:28-29': {
      kind: 'authored',
      by: 'human:Shanks',
      createdAt: '2026-06-08T00:00:00.000Z',
      range: { from: 28, to: 29 },
    },
    'c-unresolved': {
      kind: 'comment',
      by: 'human:Shanks',
      createdAt: '2026-06-08T00:00:00.000Z',
      text: 'Keep unresolved comments around for a later retry',
      threadId: 'c-unresolved',
      thread: [],
      replies: [],
      resolved: false,
      quote: 'comment anchor that is temporarily gone',
    },
  };
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  let appliedMetadata: Record<string, StoredMark> | null = null;
  try {
    appliedMetadata = applyRemoteMarks(view, staleMetadata, { pruneUnresolvedNonCommentMarks: true });
  } finally {
    console.warn = originalWarn;
  }

  assert(appliedMetadata !== null, 'Expected stale metadata cleanup to return applied metadata');
  assert(!('m-stale-local' in appliedMetadata), 'Expected stale suggestion metadata to be pruned');
  assert(!('authored:human:Shanks:28-29' in appliedMetadata), 'Expected stale authored metadata to be pruned');
  assert('c-unresolved' in appliedMetadata, 'Expected unresolved comments to be preserved');
  assert(
    !warnings.some((message) => message.includes('[applyRemoteMarks] Could not resolve remote mark')),
    'Expected stale share-mark cleanup to avoid unresolved mark console warnings',
  );

  console.log('✓ stale share-mark cleanup prunes noisy local suggestion metadata');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
