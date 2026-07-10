import { useEffect, useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getFileCategory, getFileExtension, getLanguageExtension } from "./fileUtils";
import { detectLinks, resolvePath, checkFileExists, openUrlInBrowser } from "./linkDetect";

type Props = {
  filePath: string;
  hostId?: string | null;
  onClose: () => void;
  onOpenFile?: (path: string, line?: number, col?: number, hostId?: string | null) => void;
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
  const fileName = filePath.split("/").pop() ?? filePath;
  const [src, setSrc] = useState(() => hostId ? "" : convertFileSrc(filePath));
  const [loading, setLoading] = useState(!!hostId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hostId) {
      setSrc(convertFileSrc(filePath));
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setSrc("");
    invoke<string>("remote_read_file_base64", { hostId, path: filePath })
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
    <div className="pane pane--term">
      <div className="pane__bar">
        <span className="pane__title file-editor__title">{fileName}</span>
        <div className="file-editor__actions">
          <button className="btn btn--small" type="button" onClick={onClose} title="close">
            ×
          </button>
        </div>
      </div>
      <div className="pane__body file-editor__image">
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

function CodeEditor({ filePath, hostId, onClose, isMarkdown, onOpenFile }: Props & { isMarkdown: boolean }) {
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);

  const pathRef = useRef(filePath);
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef("");
  const originalContentRef = useRef("");

  const loadFile = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    setPreviewMode(false);
    try {
      const text = hostId
        ? await invoke<string>("remote_read_file", { hostId, path })
        : await invoke<string>("read_file", { path });
      if (pathRef.current === path) {
        setContent(text);
        setOriginalContent(text);
        contentRef.current = text;
        originalContentRef.current = text;
      }
    } catch (e) {
      if (pathRef.current === path) {
        setError(String(e));
        setContent("");
        setOriginalContent("");
      }
    } finally {
      if (pathRef.current === path) {
        setLoading(false);
      }
    }
  }, [hostId]);

  useEffect(() => {
    pathRef.current = filePath;
    loadFile(filePath);
  }, [filePath, loadFile]);

  const save = useCallback(async () => {
    const cur = contentRef.current;
    if (saving || cur === originalContentRef.current) return;
    setSaving(true);
    try {
      if (hostId) {
        await invoke("remote_write_file", { hostId, path: pathRef.current, content: cur });
      } else {
        await invoke("write_file", { path: pathRef.current, content: cur });
      }
      setOriginalContent(cur);
      originalContentRef.current = cur;
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [hostId, saving]);

  // CodeMirror setup
  useEffect(() => {
    if (!editorRef.current || loading || error || previewMode) return;

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
              openUrlInBrowser(clicked.url);
            } else if (clicked.kind === "file") {
              const dir = filePath.split("/").slice(0, -1).join("/");
              const resolved = resolvePath(clicked.path, dir);
              checkFileExists(resolved, hostId).then((exists) => {
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
  }, [filePath, hostId, loading, error, previewMode, save, onOpenFile]);

  const isDirty = content !== originalContent;
  const fileName = filePath.split("/").pop() ?? filePath;

  return (
    <div className="pane pane--term">
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
          <button className="btn btn--small" type="button" onClick={onClose} title="close">
            ×
          </button>
        </div>
      </div>
      <div className="pane__body" style={{ padding: 0 }}>
        {loading ? (
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

export function FileEditor({ filePath, hostId, onClose, onOpenFile }: Props) {
  const category = getFileCategory(filePath);

  if (category === "image") {
    return <ImagePreview filePath={filePath} hostId={hostId} onClose={onClose} />;
  }

  return (
    <CodeEditor
      filePath={filePath}
      hostId={hostId}
      onClose={onClose}
      onOpenFile={onOpenFile}
      isMarkdown={category === "markdown"}
    />
  );
}
