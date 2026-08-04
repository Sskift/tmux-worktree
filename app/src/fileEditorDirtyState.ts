export type FileEditorDirtyState = Readonly<{
  sourceKey: string;
  ready: boolean;
  content: string;
  originalContent: string;
}>;

export function beginFileEditorLoad(sourceKey: string): FileEditorDirtyState {
  return {
    sourceKey,
    ready: false,
    content: "",
    originalContent: "",
  };
}

export function completeFileEditorLoad(
  state: FileEditorDirtyState,
  sourceKey: string,
  content: string,
): FileEditorDirtyState {
  if (state.sourceKey !== sourceKey) return state;
  return {
    sourceKey,
    ready: true,
    content,
    originalContent: content,
  };
}

export function editFileEditorContent(
  state: FileEditorDirtyState,
  sourceKey: string,
  content: string,
): FileEditorDirtyState {
  if (state.sourceKey !== sourceKey || !state.ready) return state;
  return { ...state, content };
}

export function markFileEditorSaved(
  state: FileEditorDirtyState,
  sourceKey: string,
  content: string,
): FileEditorDirtyState {
  if (state.sourceKey !== sourceKey || !state.ready) return state;
  return { ...state, originalContent: content };
}

export function isFileEditorDirty(state: FileEditorDirtyState): boolean {
  return state.ready && state.content !== state.originalContent;
}
