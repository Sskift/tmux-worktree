import { useEffect, useState, useRef, useCallback } from "react";
import { X } from "lucide-react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getFileCategory, getFileExtension, getLanguageExtension } from "./fileUtils";
import { detectLinks, resolvePath } from "./linkDetect";
import { checkFileExists, openUrlInBrowser } from "./linkActions";
import { useDashboardBackend } from "./platform";
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

type Props = {
  filePath: string;
  hostId?: string | null;
  onClose: () => void;
  onOpenFile?: (path: string, line?: number, col?: number, hostId?: string | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

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

function ImagePreview({ filePath, hostId, onClose }: Props) {
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
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, hostId]);

  return (
    <div className="pane pane--term file-editor">
      <div className="pane__bar">
        <span className="pane__title file-editor__title">{fileName}</span>
        <div className="file-editor__actions">
          <button className="btn btn--small" type="button" onClick={onClose} title="Close file" aria-label="Close file">
            <X aria-hidden="true" size={13} strokeWidth={1.8} />
          </button>
        </div>
      </div>
      <div className="pane__body file-editor__body file-editor__image">
        {loading ? (
          <div className="file-editor__status">loading...</div>
        ) : error ? (
          <div className="file-editor__status file-editor__status--error">{error}</div>
        ) : (
          <img src={src} alt={fileName} />
        )}
      </div>
    </div>
  );
}

/* ── Code / Markdown Editor ─────────────────────────────────── */

function CodeEditor({
  filePath,
  hostId,
  onClose,
  isMarkdown,
  onOpenFile,
  onDirtyChange,
}: Props & { isMarkdown: boolean }) {
  const dashboardBackend = useDashboardBackend();
  const sourceKey = requestSourceKey(hostId ?? null, filePath);
  const [content, setContent] = useState("");
  const [, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadedSourceKey, setLoadedSourceKey] = useState<string | null>(null);
  const [savingRequest, setSavingRequest] = useState<LatestRequestToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);

  const pathRef = useRef(filePath);
  const sourceKeyRef = useRef(sourceKey);
  const loadRequestGateRef = useRef(createLatestRequestGate());
  const saveRequestGateRef = useRef(createLatestRequestGate());
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef("");
  const originalContentRef = useRef("");
  const dirtyStateRef = useRef(beginFileEditorLoad(sourceKey));
  const reportedDirtyRef = useRef(false);
  const onDirtyChangeRef = useRef(onDirtyChange);
  sourceKeyRef.current = sourceKey;
  onDirtyChangeRef.current = onDirtyChange;

  const publishDirty = useCallback((dirty: boolean) => {
    if (reportedDirtyRef.current === dirty) return;
    reportedDirtyRef.current = dirty;
    onDirtyChangeRef.current?.(dirty);
  }, []);

  useEffect(() => {
    const requestGate = loadRequestGateRef.current;
    const request = requestGate.issue(sourceKey);
    saveRequestGateRef.current.invalidate();
    pathRef.current = filePath;
    dirtyStateRef.current = beginFileEditorLoad(sourceKey);
    publishDirty(false);
    setLoading(true);
    setError(null);
    setPreviewMode(false);
    const read = hostId
      ? dashboardBackend.files.readRemote(hostId, filePath)
      : dashboardBackend.files.read(filePath);

    void read
      .then((text) => {
        if (!requestGate.isCurrent(request)) return;
        setContent(text);
        setOriginalContent(text);
        contentRef.current = text;
        originalContentRef.current = text;
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
        setError(String(nextError));
        setContent("");
        setOriginalContent("");
        contentRef.current = "";
        originalContentRef.current = "";
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
    const cur = contentRef.current;
    if (saving || cur === originalContentRef.current) return;
    const requestGate = saveRequestGateRef.current;
    const request = requestGate.issue(sourceKey);
    setSavingRequest(request);
    try {
      if (hostId) {
        await dashboardBackend.files.writeRemote(hostId, pathRef.current, cur);
      } else {
        await dashboardBackend.files.write(pathRef.current, cur);
      }
      if (
        !requestGate.isCurrent(request) ||
        sourceKeyRef.current !== request.sourceKey
      ) {
        return;
      }
      setOriginalContent(cur);
      originalContentRef.current = cur;
      dirtyStateRef.current = markFileEditorSaved(
        dirtyStateRef.current,
        sourceKey,
        cur,
      );
      publishDirty(isFileEditorDirty(dirtyStateRef.current));
      setError(null);
    } catch (nextError) {
      if (
        requestGate.isCurrent(request) &&
        sourceKeyRef.current === request.sourceKey
      ) {
        setError(String(nextError));
      }
    } finally {
      setSavingRequest((current) =>
        current?.sequence === request.sequence ? null : current,
      );
    }
  }, [dashboardBackend.files, hostId, publishDirty, saving, sourceKey]);

  // CodeMirror setup
  useEffect(() => {
    if (!editorRef.current || effectiveLoading || error || previewMode) return;

    let destroyed = false;

    const buildEditor = async () => {
      const langExt = await getLanguageExtension(filePath);
      if (destroyed) return;

      const extensions = [
        basicSetup,
        oneDark,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newContent = update.state.doc.toString();
            contentRef.current = newContent;
            dirtyStateRef.current = editFileEditorContent(
              dirtyStateRef.current,
              sourceKey,
              newContent,
            );
            publishDirty(isFileEditorDirty(dirtyStateRef.current));
            setContent(newContent);
          }
        }),
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              save();
              return true;
            },
          },
        ]),
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { overflow: "auto" },
        }),
        EditorView.domEventHandlers({
          click(event: MouseEvent, view: EditorView) {
            if (!event.metaKey) return false;
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos === null) return false;
            const line = view.state.doc.lineAt(pos);
            const colInLine = pos - line.from;
            const links = detectLinks(line.text);
            const clicked = links.find(
              (l) => colInLine >= l.startIndex && colInLine < l.endIndex,
            );
            if (!clicked) return false;
            if (clicked.kind === "url") {
              openUrlInBrowser(dashboardBackend, clicked.url);
            } else if (clicked.kind === "file") {
              const dir = filePath.split("/").slice(0, -1).join("/");
              const resolved = resolvePath(clicked.path, dir);
              checkFileExists(dashboardBackend, resolved, hostId).then((exists) => {
                if (exists && onOpenFile) {
                  onOpenFile(resolved, clicked.line, clicked.col, hostId);
                }
              });
            }
            event.preventDefault();
            return true;
          },
        }),
      ];

      if (langExt) extensions.push(langExt);

      const state = EditorState.create({
        doc: contentRef.current,
        extensions,
      });

      viewRef.current = new EditorView({
        state,
        parent: editorRef.current!,
      });
    };

    buildEditor();

    return () => {
      destroyed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [filePath, hostId, effectiveLoading, error, previewMode, publishDirty, save, onOpenFile, sourceKey]);

  const isDirty = sourceReady && isFileEditorDirty(dirtyStateRef.current);
  const fileName = filePath.split("/").pop() ?? filePath;

  return (
    <div className="pane pane--term file-editor">
      <div className="pane__bar">
        <span className="pane__title file-editor__title">
          {fileName}
          {isDirty && <span className="file-editor__modified" />}
        </span>
        <div className="file-editor__actions">
          {isMarkdown && (
            <button
              className={`btn btn--small file-editor__toggle${previewMode ? " file-editor__toggle--active" : ""}`}
              type="button"
              onClick={() => setPreviewMode((v) => !v)}
              title={previewMode ? "edit" : "preview"}
            >
              {previewMode ? "edit" : "preview"}
            </button>
          )}
          {isDirty && (
            <button
              className="btn btn--small"
              type="button"
              onClick={save}
              disabled={saving}
              title="save (⌘S)"
            >
              {saving ? "..." : "save"}
            </button>
          )}
          <button className="btn btn--small" type="button" onClick={onClose} title="Close file" aria-label="Close file">
            <X aria-hidden="true" size={13} strokeWidth={1.8} />
          </button>
        </div>
      </div>
      <div className="pane__body file-editor__body">
        {effectiveLoading ? (
          <div className="file-editor__status">loading...</div>
        ) : error ? (
          <div className="file-editor__status file-editor__status--error">{error}</div>
        ) : previewMode ? (
          <div className="file-editor__markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
          </div>
        ) : (
          <div className="file-editor__cm" ref={editorRef} />
        )}
      </div>
    </div>
  );
}

/* ── Main Export ─────────────────────────────────────────────── */

export function FileEditor({ filePath, hostId, onClose, onOpenFile, onDirtyChange }: Props) {
  const category = getFileCategory(filePath);

  useEffect(() => {
    if (category === "image") onDirtyChange?.(false);
    return () => onDirtyChange?.(false);
  }, [category, filePath, hostId, onDirtyChange]);

  if (category === "image") {
    return <ImagePreview filePath={filePath} hostId={hostId} onClose={onClose} />;
  }

  return (
    <CodeEditor
      filePath={filePath}
      hostId={hostId}
      onClose={onClose}
      onOpenFile={onOpenFile}
      onDirtyChange={onDirtyChange}
      isMarkdown={category === "markdown"}
    />
  );
}
