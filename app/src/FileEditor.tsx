import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronRight,
  Code2,
  Eye,
  Image as ImageIcon,
  ListOrdered,
  Save,
  Search,
  WrapText,
  X,
} from "lucide-react";
import { basicSetup } from "codemirror";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  type Text,
} from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { EditorView, keymap } from "@codemirror/view";
import { gotoLine, openSearchPanel } from "@codemirror/search";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  detectEditorIndentation,
  getFileCategory,
  getFileExtension,
  getFileTypeBadge,
  getLanguageExtension,
  getLanguageLabel,
  getLineEndingLabel,
  type EditorIndentation,
} from "./fileUtils";
import { detectLinks, resolvePath } from "./linkDetect";
import { checkFileExists, openUrlInBrowser } from "./linkActions";
import { useDashboardBackend } from "./platform";
import { THEME_CHANGED_EVENT } from "./themes";
import { createDashboardEditorTheme, indentGuides } from "./editorTheme";
import {
  createLatestRequestGate,
  requestSourceKey,
  type LatestRequestToken,
} from "./latestRequestGate";
import {
  beginFileEditorLoad,
  completeFileEditorLoad,
  editFileEditorContent,
  isFileEditorDirty,
  markFileEditorSaved,
} from "./fileEditorDirtyState";
import "./FileEditor.css";

export type FileEditorProps = {
  filePath: string;
  hostId?: string | null;
  initialLine?: number;
  initialColumn?: number;
  /** Changes when the caller repeats an explicit jump to the same location. */
  navigationRevision?: number;
  onClose: () => void;
  onOpenFile?: (path: string, line?: number, col?: number, hostId?: string | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

type CursorPosition = { line: number; column: number };

type FileChromeProps = {
  filePath: string;
  dirty?: boolean;
  image?: boolean;
  onClose: () => void;
  tools?: ReactNode;
};

function FileChrome({ filePath, dirty = false, image = false, onClose, tools }: FileChromeProps) {
  const parts = filePath.split("/").filter(Boolean);
  const fileName = parts.at(-1) ?? filePath;
  const directories = parts.slice(0, -1);
  const visibleDirectories = directories.slice(-4);

  return (
    <header className="file-editor__chrome">
      <div className="file-editor__tab-row" role="tablist" aria-label="Open files">
        <div className="file-editor__tab-shell" role="presentation">
          <div
            id="file-editor-active-tab"
            className="file-editor__tab"
            role="tab"
            aria-selected="true"
            aria-controls="file-editor-active-panel"
            aria-label={fileName}
            tabIndex={0}
            title={filePath}
          >
            {image && (
              <ImageIcon className="file-editor__tab-icon" aria-hidden="true" size={13} strokeWidth={1.8} />
            )}
            {!image && <span className="file-editor__badge" aria-hidden="true">{getFileTypeBadge(filePath)}</span>}
            <span className="file-editor__tab-name">{fileName}</span>
            {dirty && <span className="file-editor__modified" aria-label="Unsaved changes" />}
          </div>
          <button
            className="file-editor__tab-close"
            type="button"
            onClick={onClose}
            title="Close file"
            aria-label={`Close ${fileName}`}
          >
            <X aria-hidden="true" size={13} strokeWidth={1.8} />
          </button>
        </div>
      </div>
      <div className="file-editor__breadcrumb-row">
        <nav className="file-editor__breadcrumb" aria-label="File path" title={filePath}>
          {directories.length > visibleDirectories.length && (
            <span className="file-editor__breadcrumb-part">…</span>
          )}
          {visibleDirectories.map((part, index) => (
            <span className="file-editor__breadcrumb-group" key={`${part}:${index}`}>
              <ChevronRight aria-hidden="true" size={11} strokeWidth={1.6} />
              <span className="file-editor__breadcrumb-part">{part}</span>
            </span>
          ))}
          <span className="file-editor__breadcrumb-group file-editor__breadcrumb-group--current">
            <ChevronRight aria-hidden="true" size={11} strokeWidth={1.6} />
            <span className="file-editor__breadcrumb-part">{fileName}</span>
          </span>
        </nav>
        {tools && <div className="file-editor__tools">{tools}</div>}
      </div>
    </header>
  );
}

/* ── Image Preview ──────────────────────────────────────────── */

function imageMimeType(filePath: string): string {
  switch (getFileExtension(filePath)) {
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "svg": return "image/svg+xml";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "bmp": return "image/bmp";
    case "ico": return "image/x-icon";
    case "avif": return "image/avif";
    default: return "image/png";
  }
}

function ImagePreview({ filePath, hostId, onClose }: FileEditorProps) {
  const dashboardBackend = useDashboardBackend();
  const fileName = filePath.split("/").pop() ?? filePath;
  const [src, setSrc] = useState(() => hostId ? "" : dashboardBackend.files.assetUrl(filePath));
  const [loading, setLoading] = useState(!!hostId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hostId) {
      setSrc(dashboardBackend.files.assetUrl(filePath));
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setSrc("");
    dashboardBackend.files.readRemoteBase64(hostId, filePath)
      .then((data) => {
        if (!cancelled) setSrc(`data:${imageMimeType(filePath)};base64,${data}`);
      })
      .catch((nextError) => {
        if (!cancelled) setError(String(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dashboardBackend.files, filePath, hostId]);

  return (
    <div className="pane pane--term file-editor">
      <FileChrome filePath={filePath} image onClose={onClose} />
      <div
        id="file-editor-active-panel"
        className="pane__body file-editor__body file-editor__image"
        role="tabpanel"
        aria-labelledby="file-editor-active-tab"
      >
        {loading ? (
          <div className="file-editor__message">Loading image…</div>
        ) : error ? (
          <div className="file-editor__message file-editor__message--error">{error}</div>
        ) : (
          <img src={src} alt={fileName} />
        )}
      </div>
      <div className="file-editor__statusbar" aria-label="Image information">
        <span>{getFileTypeBadge(filePath)} image</span>
        <span className="file-editor__status-spacer" />
        <span className="file-editor__connection"><i aria-hidden="true" />{hostId ? "Remote" : "Local"}</span>
      </div>
    </div>
  );
}

/* ── Code / Markdown Editor ─────────────────────────────────── */

function editorPosition(doc: Text, line?: number, column?: number): number {
  const lineNumber = Math.min(Math.max(Math.trunc(line ?? 1), 1), doc.lines);
  const targetLine = doc.line(lineNumber);
  const columnNumber = Math.min(Math.max(Math.trunc(column ?? 1), 1), targetLine.length + 1);
  return targetLine.from + columnNumber - 1;
}

function selectionPosition(view: EditorView): CursorPosition {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return { line: line.number, column: head - line.from + 1 };
}

function indentationExtension(indentation: EditorIndentation) {
  return indentUnit.of(indentation.kind === "tabs" ? "\t" : " ".repeat(indentation.size));
}

function sameCursorPosition(left: CursorPosition, right: CursorPosition): boolean {
  return left.line === right.line && left.column === right.column;
}

function CodeEditor({
  filePath,
  hostId,
  initialLine,
  initialColumn,
  navigationRevision,
  onClose,
  isMarkdown,
  onOpenFile,
  onDirtyChange,
}: FileEditorProps & { isMarkdown: boolean }) {
  const dashboardBackend = useDashboardBackend();
  const sourceKey = requestSourceKey(hostId ?? null, filePath);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadedSourceKey, setLoadedSourceKey] = useState<string | null>(null);
  const [savingRequest, setSavingRequest] = useState<LatestRequestToken | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [wordWrap, setWordWrap] = useState(false);
  const [cursor, setCursor] = useState<CursorPosition>({ line: 1, column: 1 });
  const [indentation, setIndentation] = useState<EditorIndentation>({ kind: "spaces", size: 2 });
  const [lineEnding, setLineEnding] = useState<"CRLF" | "LF">("LF");

  const pathRef = useRef(filePath);
  const hostIdRef = useRef(hostId);
  const sourceKeyRef = useRef(sourceKey);
  const initialLineRef = useRef(initialLine);
  const initialColumnRef = useRef(initialColumn);
  const onOpenFileRef = useRef(onOpenFile);
  const loadRequestGateRef = useRef(createLatestRequestGate());
  const saveRequestGateRef = useRef(createLatestRequestGate());
  const savingRequestRef = useRef<LatestRequestToken | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef("");
  const originalContentRef = useRef("");
  const dirtyStateRef = useRef(beginFileEditorLoad(sourceKey));
  const reportedDirtyRef = useRef(false);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const saveRef = useRef<() => void>(() => undefined);
  const wordWrapRef = useRef(wordWrap);
  const themeCompartmentRef = useRef(new Compartment());
  const wrapCompartmentRef = useRef(new Compartment());
  const indentationCompartmentRef = useRef(new Compartment());

  pathRef.current = filePath;
  hostIdRef.current = hostId;
  sourceKeyRef.current = sourceKey;
  initialLineRef.current = initialLine;
  initialColumnRef.current = initialColumn;
  onOpenFileRef.current = onOpenFile;
  onDirtyChangeRef.current = onDirtyChange;
  wordWrapRef.current = wordWrap;

  const publishDirty = useCallback((dirty: boolean) => {
    if (reportedDirtyRef.current === dirty) return;
    reportedDirtyRef.current = dirty;
    onDirtyChangeRef.current?.(dirty);
  }, []);

  useEffect(() => {
    const requestGate = loadRequestGateRef.current;
    const request = requestGate.issue(sourceKey);
    saveRequestGateRef.current.invalidate();
    savingRequestRef.current = null;
    setSavingRequest(null);
    pathRef.current = filePath;
    dirtyStateRef.current = beginFileEditorLoad(sourceKey);
    publishDirty(false);
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    setPreviewMode(false);
    setCursor({ line: 1, column: 1 });
    const read = hostId
      ? dashboardBackend.files.readRemote(hostId, filePath)
      : dashboardBackend.files.read(filePath);

    void read
      .then((text) => {
        if (!requestGate.isCurrent(request)) return;
        const nextIndentation = detectEditorIndentation(text);
        const nextLineEnding = getLineEndingLabel(text);
        setContent(text);
        contentRef.current = text;
        originalContentRef.current = text;
        setIndentation(nextIndentation);
        setLineEnding(nextLineEnding);
        dirtyStateRef.current = completeFileEditorLoad(
          dirtyStateRef.current,
          sourceKey,
          text,
        );
        publishDirty(isFileEditorDirty(dirtyStateRef.current));
        setLoadedSourceKey(sourceKey);
        setLoading(false);
      })
      .catch((nextError) => {
        if (!requestGate.isCurrent(request)) return;
        setLoadError(String(nextError));
        setContent("");
        contentRef.current = "";
        originalContentRef.current = "";
        setIndentation({ kind: "spaces", size: 2 });
        setLineEnding("LF");
        dirtyStateRef.current = completeFileEditorLoad(
          dirtyStateRef.current,
          sourceKey,
          "",
        );
        publishDirty(isFileEditorDirty(dirtyStateRef.current));
        setLoadedSourceKey(sourceKey);
        setLoading(false);
      });

    return () => requestGate.cancel(request);
  }, [dashboardBackend.files, filePath, hostId, publishDirty, sourceKey]);

  const sourceReady = loadedSourceKey === sourceKey;
  const effectiveLoading = loading || !sourceReady;
  const saving = savingRequest?.sourceKey === sourceKey;

  const save = useCallback(async () => {
    const currentContent = contentRef.current;
    if (
      savingRequestRef.current?.sourceKey === sourceKey ||
      currentContent === originalContentRef.current
    ) {
      return;
    }

    const requestGate = saveRequestGateRef.current;
    const request = requestGate.issue(sourceKey);
    savingRequestRef.current = request;
    setSavingRequest(request);
    try {
      if (hostId) {
        await dashboardBackend.files.writeRemote(hostId, pathRef.current, currentContent);
      } else {
        await dashboardBackend.files.write(pathRef.current, currentContent);
      }
      if (
        !requestGate.isCurrent(request) ||
        sourceKeyRef.current !== request.sourceKey
      ) {
        return;
      }
      originalContentRef.current = currentContent;
      dirtyStateRef.current = markFileEditorSaved(
        dirtyStateRef.current,
        sourceKey,
        currentContent,
      );
      publishDirty(isFileEditorDirty(dirtyStateRef.current));
      setSaveError(null);
    } catch (nextError) {
      if (
        requestGate.isCurrent(request) &&
        sourceKeyRef.current === request.sourceKey
      ) {
        setSaveError(String(nextError));
      }
    } finally {
      if (savingRequestRef.current?.sequence === request.sequence) {
        savingRequestRef.current = null;
      }
      setSavingRequest((current) =>
        current?.sequence === request.sequence ? null : current,
      );
    }
  }, [dashboardBackend.files, hostId, publishDirty, sourceKey]);

  saveRef.current = () => {
    void save();
  };

  // CodeMirror is created once per source. Saving, cursor changes, wrapping,
  // and Dashboard theme changes use transactions so undo history and scroll
  // position are never discarded by an ordinary React render.
  useEffect(() => {
    if (!editorRef.current || effectiveLoading || loadError) return;

    let destroyed = false;
    let animationFrame = 0;

    const buildEditor = async () => {
      const language = await getLanguageExtension(filePath);
      if (destroyed || !editorRef.current) return;

      const initialContent = contentRef.current;
      const detectedIndentation = detectEditorIndentation(initialContent);
      const detectedLineEnding = getLineEndingLabel(initialContent);
      const position = editorPosition(
        EditorState.create({ doc: initialContent }).doc,
        initialLineRef.current,
        initialColumnRef.current,
      );
      const extensions: Extension[] = [
        basicSetup,
        themeCompartmentRef.current.of(createDashboardEditorTheme(editorRef.current)),
        wrapCompartmentRef.current.of(wordWrapRef.current ? EditorView.lineWrapping : []),
        indentationCompartmentRef.current.of(indentationExtension(detectedIndentation)),
        EditorState.lineSeparator.of(detectedLineEnding === "CRLF" ? "\r\n" : "\n"),
        indentGuides,
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) {
            const nextCursor = selectionPosition(update.view);
            setCursor((current) => sameCursorPosition(current, nextCursor) ? current : nextCursor);
          }
          if (update.docChanged) {
            const nextContent = update.state.sliceDoc();
            contentRef.current = nextContent;
            dirtyStateRef.current = editFileEditorContent(
              dirtyStateRef.current,
              sourceKey,
              nextContent,
            );
            publishDirty(isFileEditorDirty(dirtyStateRef.current));
            setContent(nextContent);
          }
        }),
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              saveRef.current();
              return true;
            },
          },
        ]),
        EditorView.domEventHandlers({
          click(event: MouseEvent, view: EditorView) {
            if (!event.metaKey) return false;
            const clickedPosition = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (clickedPosition === null) return false;
            const line = view.state.doc.lineAt(clickedPosition);
            const columnInLine = clickedPosition - line.from;
            const links = detectLinks(line.text);
            const clicked = links.find(
              (link) => columnInLine >= link.startIndex && columnInLine < link.endIndex,
            );
            if (!clicked) return false;
            if (clicked.kind === "url") {
              openUrlInBrowser(dashboardBackend, clicked.url);
            } else if (clicked.kind === "file") {
              const directory = pathRef.current.split("/").slice(0, -1).join("/");
              const resolved = resolvePath(clicked.path, directory);
              void checkFileExists(dashboardBackend, resolved, hostIdRef.current).then((exists) => {
                if (exists) {
                  onOpenFileRef.current?.(
                    resolved,
                    clicked.line,
                    clicked.col,
                    hostIdRef.current,
                  );
                }
              });
            }
            event.preventDefault();
            return true;
          },
        }),
      ];

      if (language) extensions.push(language);

      const state = EditorState.create({
        doc: initialContent,
        selection: EditorSelection.cursor(position),
        extensions,
      });
      const view = new EditorView({ state, parent: editorRef.current });
      viewRef.current = view;
      setCursor(selectionPosition(view));
      animationFrame = window.requestAnimationFrame(() => {
        if (viewRef.current !== view) return;
        view.dispatch({ effects: EditorView.scrollIntoView(position, { y: "center" }) });
      });
    };

    void buildEditor();

    return () => {
      destroyed = true;
      window.cancelAnimationFrame(animationFrame);
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [dashboardBackend, effectiveLoading, filePath, loadError, publishDirty, sourceKey]);

  useEffect(() => {
    const handleThemeChange = () => {
      const view = viewRef.current;
      if (!view) return;
      window.requestAnimationFrame(() => {
        if (viewRef.current !== view) return;
        view.dispatch({
          effects: themeCompartmentRef.current.reconfigure(createDashboardEditorTheme(view.dom)),
        });
      });
    };
    window.addEventListener(THEME_CHANGED_EVENT, handleThemeChange);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, handleThemeChange);
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || effectiveLoading || loadError) return;
    const position = editorPosition(view.state.doc, initialLine, initialColumn);
    view.dispatch({
      selection: EditorSelection.cursor(position),
      effects: EditorView.scrollIntoView(position, { y: "center" }),
    });
  }, [effectiveLoading, initialColumn, initialLine, loadError, navigationRevision, sourceKey]);

  useEffect(() => {
    if (previewMode) return;
    const frame = window.requestAnimationFrame(() => viewRef.current?.requestMeasure());
    return () => window.cancelAnimationFrame(frame);
  }, [previewMode]);

  const toggleWordWrap = useCallback(() => {
    setWordWrap((current) => {
      const next = !current;
      wordWrapRef.current = next;
      const view = viewRef.current;
      if (view) {
        view.dispatch({
          effects: wrapCompartmentRef.current.reconfigure(next ? EditorView.lineWrapping : []),
        });
      }
      return next;
    });
  }, []);

  const openFind = useCallback(() => {
    const view = viewRef.current;
    if (view) openSearchPanel(view);
  }, []);

  const openGoToLine = useCallback(() => {
    const view = viewRef.current;
    if (view) gotoLine(view);
  }, []);

  const isDirty = sourceReady && isFileEditorDirty(dirtyStateRef.current);
  const languageLabel = getLanguageLabel(filePath);
  const indentationLabel = indentation.kind === "tabs"
    ? `Tabs: ${indentation.size}`
    : `Spaces: ${indentation.size}`;
  const editorControlsDisabled = effectiveLoading || Boolean(loadError) || previewMode;

  const tools = (
    <>
      <button
        className="file-editor__tool"
        type="button"
        onClick={openFind}
        disabled={editorControlsDisabled}
        title="Find in file (⌘F)"
        aria-label="Find in file"
      >
        <Search aria-hidden="true" size={13} strokeWidth={1.8} />
        <span>Find</span>
      </button>
      <button
        className="file-editor__tool file-editor__tool--icon"
        type="button"
        onClick={openGoToLine}
        disabled={editorControlsDisabled}
        title="Go to line (⌘⌥G)"
        aria-label="Go to line"
      >
        <ListOrdered aria-hidden="true" size={13} strokeWidth={1.8} />
      </button>
      <button
        className={`file-editor__tool file-editor__tool--icon${wordWrap ? " file-editor__tool--active" : ""}`}
        type="button"
        onClick={toggleWordWrap}
        disabled={editorControlsDisabled}
        title={wordWrap ? "Disable word wrap" : "Enable word wrap"}
        aria-label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
        aria-pressed={wordWrap}
      >
        <WrapText aria-hidden="true" size={13} strokeWidth={1.8} />
      </button>
      {isMarkdown && (
        <button
          className={`file-editor__tool${previewMode ? " file-editor__tool--active" : ""}`}
          type="button"
          onClick={() => setPreviewMode((current) => !current)}
          title={previewMode ? "Edit Markdown" : "Preview Markdown"}
          aria-pressed={previewMode}
        >
          {previewMode ? <Code2 aria-hidden="true" size={13} /> : <Eye aria-hidden="true" size={13} />}
          <span>{previewMode ? "Edit" : "Preview"}</span>
        </button>
      )}
      {isDirty && (
        <button
          className="file-editor__tool file-editor__tool--save"
          type="button"
          onClick={() => void save()}
          disabled={saving}
          title="Save (⌘S)"
        >
          <Save aria-hidden="true" size={13} strokeWidth={1.8} />
          <span>{saving ? "Saving" : "Save"}</span>
        </button>
      )}
    </>
  );

  return (
    <div className="pane pane--term file-editor">
      <FileChrome filePath={filePath} dirty={isDirty} onClose={onClose} tools={tools} />
      <div
        id="file-editor-active-panel"
        className="pane__body file-editor__body"
        role="tabpanel"
        aria-labelledby="file-editor-active-tab"
      >
        {effectiveLoading ? (
          <div className="file-editor__message">Loading editor…</div>
        ) : loadError ? (
          <div className="file-editor__message file-editor__message--error">{loadError}</div>
        ) : (
          <>
            <div
              className="file-editor__cm"
              ref={editorRef}
              hidden={previewMode}
              aria-hidden={previewMode}
            />
            {previewMode && (
              <div className="file-editor__markdown">
                <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
              </div>
            )}
          </>
        )}
      </div>
      <div className="file-editor__statusbar" aria-label="Editor status">
        {saveError ? (
          <span className="file-editor__save-error" title={saveError}>Save failed</span>
        ) : saving ? (
          <span>Saving…</span>
        ) : null}
        <span className="file-editor__status-spacer" />
        <span className="file-editor__status-cursor">Ln {cursor.line}, Col {cursor.column}</span>
        <span className="file-editor__status-secondary">{indentationLabel}</span>
        <span className="file-editor__status-secondary">UTF-8</span>
        <span className="file-editor__status-secondary">{lineEnding}</span>
        <span className="file-editor__status-language">{languageLabel}</span>
        <span className="file-editor__language-badge" aria-hidden="true">{getFileTypeBadge(filePath)}</span>
        <span className="file-editor__connection"><i aria-hidden="true" />{hostId ? "Remote" : "Local"}</span>
      </div>
    </div>
  );
}

/* ── Main Export ─────────────────────────────────────────────── */

export function FileEditor(props: FileEditorProps) {
  const { filePath, hostId, onDirtyChange } = props;
  const category = getFileCategory(filePath);

  useEffect(() => {
    if (category === "image") onDirtyChange?.(false);
    return () => onDirtyChange?.(false);
  }, [category, filePath, hostId, onDirtyChange]);

  if (category === "image") {
    return <ImagePreview {...props} />;
  }

  return <CodeEditor {...props} isMarkdown={category === "markdown"} />;
}
